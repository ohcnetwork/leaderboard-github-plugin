import { subDays } from "date-fns";
import { activityQueries, Logger } from "@ohcnetwork/leaderboard-api";
import { PluginContext } from "@ohcnetwork/leaderboard-api";
import { Activity } from "@ohcnetwork/leaderboard-api";
import {
  ActivityDefinition,
  type ActivityDefinitionConfig,
  type CommitActivityDefinitionOverride,
  getDisabledSlugs,
} from "./activity";
import {
  OctokitPool,
  getOctokitPool,
  withTokenRotation,
  describeError,
  isNodeLimitError,
  GitHubResponseShapeError,
} from "./octokit";
import { addNewContributors, updateBotRoles } from "@/src/db";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

interface GitHubApiFetchOptions {
  pool: OctokitPool;
  org: string;
  repo: string;
  since: string | undefined;
  branch?: string;
  botUsers: Set<string>;
  logger: Logger;
}

/**
 * Result of a single data source within a repository. `partial` means some
 * pages were fetched successfully before an unrecoverable error stopped the
 * pagination — the items collected so far are still usable.
 */
interface FetchResult<T> {
  items: T[];
  partial: boolean;
  error?: string;
}

function complete<T>(items: T[]): FetchResult<T> {
  return { items, partial: false };
}

type SourceStatus = "completed" | "partial" | "failed";

interface SourceProgress {
  status: SourceStatus;
  error?: string;
}

interface RepoProgress {
  repo: string;
  status: "completed" | "partial" | "failed" | "in_progress";
  activitiesCount: number;
  error?: string;
  completedAt?: string;
  sources?: Record<string, SourceProgress>;
}

interface ScrapeProgress {
  org: string;
  startedAt: string;
  updatedAt: string;
  totalRepos: number;
  completedRepos: number;
  partialRepos: number;
  failedRepos: number;
  totalActivities: number;
  repos: Record<string, RepoProgress>;
}

function getProgressFilePath(dataDir?: string): string {
  const base = dataDir || process.env.LEADERBOARD_DATA_DIR || "./data";
  return join(base, ".scrape-progress.json");
}

function getProgressMdPath(dataDir?: string): string {
  const base = dataDir || process.env.LEADERBOARD_DATA_DIR || "./data";
  return join(base, "scrape-status.md");
}

async function loadProgress(dataDir?: string): Promise<ScrapeProgress | null> {
  try {
    const raw = await readFile(getProgressFilePath(dataDir), "utf-8");
    return JSON.parse(raw) as ScrapeProgress;
  } catch {
    return null;
  }
}

async function saveProgress(
  progress: ScrapeProgress,
  dataDir?: string,
): Promise<void> {
  progress.updatedAt = new Date().toISOString();
  const filePath = getProgressFilePath(dataDir);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(progress, null, 2), "utf-8");
  await writeProgressMarkdown(progress, dataDir);
}

const STATUS_ICONS: Record<string, string> = {
  completed: "✅",
  partial: "⚠️",
  failed: "❌",
  in_progress: "⏳",
};

async function writeProgressMarkdown(
  progress: ScrapeProgress,
  dataDir?: string,
): Promise<void> {
  const countByStatus = (status: RepoProgress["status"]) =>
    Object.values(progress.repos).filter((r) => r.status === status).length;

  const completedCount = countByStatus("completed");
  const partialCount = countByStatus("partial");
  const failedCount = countByStatus("failed");
  const pendingCount =
    progress.totalRepos - completedCount - partialCount - failedCount;

  const lines = [
    `# Scrape Progress`,
    ``,
    `**Organization:** ${progress.org}`,
    `**Started:** ${progress.startedAt}`,
    `**Last Updated:** ${progress.updatedAt}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Repos | ${progress.totalRepos} |`,
    `| Completed | ${completedCount} |`,
    `| Partial | ${partialCount} |`,
    `| Failed | ${failedCount} |`,
    `| Pending | ${pendingCount} |`,
    `| Total Activities | ${progress.totalActivities} |`,
    ``,
    `## Repositories`,
    ``,
    `| # | Repository | Status | Activities | Completed At |`,
    `|---|------------|--------|------------|--------------|`,
  ];

  const allRepoNames = Object.keys(progress.repos).sort();
  let i = 1;
  for (const name of allRepoNames) {
    const r = progress.repos[name]!;
    const icon = STATUS_ICONS[r.status] ?? "⏳";
    const err = r.error ? ` (${r.error})` : "";
    lines.push(
      `| ${i++} | ${r.repo} | ${icon} ${r.status}${err} | ${r.activitiesCount} | ${r.completedAt ?? "-"} |`,
    );
  }

  const degraded = allRepoNames
    .map((name) => progress.repos[name]!)
    .filter((r) =>
      Object.values(r.sources ?? {}).some((s) => s.status !== "completed"),
    );

  if (degraded.length > 0) {
    lines.push(
      ``,
      `## Source Failures`,
      ``,
      `| Repository | Source | Status | Error |`,
      `|------------|--------|--------|-------|`,
    );
    for (const repo of degraded) {
      for (const [source, state] of Object.entries(repo.sources ?? {})) {
        if (state.status === "completed") continue;
        lines.push(
          `| ${repo.repo} | ${source} | ${STATUS_ICONS[state.status] ?? ""} ${state.status} | ${state.error ?? "-"} |`,
        );
      }
    }
  }

  if (pendingCount > 0) {
    lines.push(``, `*${pendingCount} repositories not yet started.*`);
  }

  lines.push(``);

  await writeFile(getProgressMdPath(dataDir), lines.join("\n"), "utf-8");
}
/**
 * Get all repositories from a GitHub organization
 * If since is provided, only get repositories updated since the date
 *
 * @returns An array of repositories
 */
async function getRepositories({
  pool,
  org,
  since,
  logger,
}: GitHubApiFetchOptions) {
  return withTokenRotation(pool, async (octokit) => {
    const repos = [];

    for await (const response of octokit.paginate.iterator(
      "GET /orgs/{org}/repos",
      {
        org,
        sort: "updated",
        type: "sources",
      },
    )) {
      logger.info(`Found ${response.data.length} repositories`);
      for (const repo of response.data) {
        if (
          since &&
          repo.updated_at &&
          new Date(repo.updated_at) < new Date(since)
        ) {
          logger.debug(
            `Skipping repository ${repo.name} as it is older than ${since}`,
          );
          return repos;
        }

        if (!repo.updated_at) {
          logger.warn(`Repository ${repo.name} has no updated_at`);
          continue;
        }

        repos.push({
          name: repo.name,
          url: repo.html_url,
          defaultBranch: repo.default_branch,
        });
      }
    }

    return repos;
  });
}

/**
 * GitHub answers with `{}` or `{ repository: null }` when a query is degraded
 * or partially resolved, so the payload has to be checked before use.
 */
function assertRepositoryPayload<K extends string>(
  response: unknown,
  repo: string,
  field: K,
): asserts response is Record<"repository", Record<K, unknown>> {
  const repository = (response as { repository?: unknown } | undefined)
    ?.repository;

  if (repository == null || (repository as Record<K, unknown>)[field] == null) {
    throw new GitHubResponseShapeError(
      `GraphQL response for ${repo} did not include repository.${field}`,
    );
  }
}

/**
 * Descending page sizes tried in order. Large repositories exceed GitHub's
 * GraphQL node budget or query timeout at the higher sizes.
 */
const PR_PAGE_SIZES = [50, 25, 10] as const;
const ISSUE_PAGE_SIZES = [50, 25, 10] as const;
const REST_PAGE_SIZE = 100;

/**
 * Get all pull requests and their reviews from a repository using GraphQL
 * If since is provided, only get pull requests updated since the date
 * @param repo - The repository to get pull requests from
 * @param since - The date to start getting pull requests from based on the `updated_at` field (optional)
 * @returns An array of pull requests with their reviews
 */
async function getPRsAndReviews({
  pool,
  org,
  repo,
  since,
  botUsers,
  logger,
}: GitHubApiFetchOptions) {
  type PullRequestRecord = {
    number: number;
    title: string;
    url: string;
    author: string | null;
    updated_at: string;
    created_at: string;
    merged_at: string | null;
    merged_by: string | null;
    reviews: Array<{
      id: string;
      author: string | null;
      state: string;
      submitted_at: string | null;
      html_url: string | null;
    }>;
  };

  const pullRequests: PullRequestRecord[] = [];

  let hasNextPage = true;
  let cursor: string | null = null;
  let pageSizeIndex = 0;

  logger.info(`Fetching pull requests from ${repo}...`);

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String, $pageSize: Int!, $reviewCount: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequests(
            first: $pageSize
            orderBy: { field: UPDATED_AT, direction: DESC }
            after: $cursor
          ) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              number
              title
              url
              author {
                __typename
                login
              }
              updatedAt
              createdAt
              mergedAt
              mergedBy {
                __typename
                login
              }
              reviews(first: $reviewCount) {
                nodes {
                  id
                  author {
                    __typename
                    login
                  }
                  state
                  submittedAt
                  url
                  comments(first: 10) {
                    nodes {
                      id
                      replyTo {
                        id
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    type PullRequestPage = {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            title: string;
            url: string;
            author: { login: string | null; __typename?: string };
            updatedAt: string;
            createdAt: string;
            mergedAt: string | null;
            mergedBy: { login: string | null; __typename?: string };
            reviews: {
              nodes: Array<{
                author: { login: string | null; __typename?: string };
                id: string;
                state: string;
                submittedAt: string | null;
                url: string | null;
                comments: {
                  nodes: Array<{
                    id: string;
                    replyTo: { id: string } | null;
                  }>;
                };
              }>;
            };
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };
    };

    const pageSize = PR_PAGE_SIZES[pageSizeIndex]!;
    let response: PullRequestPage;

    try {
      const raw = await withTokenRotation(
        pool,
        (octokit) =>
          octokit.graphql(query, {
            owner: org,
            repo,
            cursor,
            pageSize,
            reviewCount: pageSize,
          }),
        { label: `pull requests of ${repo}` },
      );
      assertRepositoryPayload(raw, repo, "pullRequests");
      response = raw as PullRequestPage;
    } catch (error) {
      if (pageSizeIndex < PR_PAGE_SIZES.length - 1) {
        pageSizeIndex++;
        logger.warn(
          `Pull request query for ${repo} failed at page size ${pageSize}, retrying with ${PR_PAGE_SIZES[pageSizeIndex]}: ${describeError(error)}`,
        );
        continue;
      }

      logger.warn(
        `Giving up on pull requests for ${repo} after ${pullRequests.length} fetched${isNodeLimitError(error) ? " (query too large)" : ""}: ${describeError(error)}`,
      );
      return {
        items: pullRequests,
        partial: true,
        error: describeError(error),
      } satisfies FetchResult<PullRequestRecord>;
    }

    const prs = response.repository.pullRequests.nodes;

    logger.info(`Found ${prs.length} pull requests`);

    for (const pr of prs) {
      if (since && pr.updatedAt && new Date(pr.updatedAt) < new Date(since)) {
        return complete(pullRequests);
      }

      if (!pr.updatedAt) continue;

      if (pr.author?.login && pr.author.__typename === "Bot") {
        botUsers.add(pr.author.login);
      }
      if (pr.mergedBy?.login && pr.mergedBy.__typename === "Bot") {
        botUsers.add(pr.mergedBy.login);
      }
      for (const review of pr.reviews.nodes) {
        if (review.author?.login && review.author.__typename === "Bot") {
          botUsers.add(review.author.login);
        }
      }

      pullRequests.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login ?? null,
        updated_at: pr.updatedAt,
        created_at: pr.createdAt,
        merged_at: pr.mergedAt,
        merged_by: pr.mergedBy?.login ?? null,
        reviews: pr.reviews.nodes
          .filter((review) => {
            if (review.comments.nodes.length === 0) return true;
            return review.comments.nodes.some((comment) => !comment.replyTo);
          })
          .map((review) => ({
            id: review.id,
            author: review.author?.login ?? null,
            state: review.state,
            submitted_at: review.submittedAt,
            html_url: review.url,
          })),
      });
    }

    hasNextPage = response.repository.pullRequests.pageInfo.hasNextPage;
    cursor = response.repository.pullRequests.pageInfo.endCursor;
  }

  return complete(pullRequests);
}

async function getComments({
  pool,
  org,
  repo,
  since,
  botUsers,
  logger,
}: GitHubApiFetchOptions) {
  logger.info(`Fetching comments from ${repo}...`);

  type CommentRecord = {
    id: string;
    issue_number: string | undefined;
    body: string | undefined;
    created_at: string;
    author: string | undefined;
    html_url: string;
  };

  const comments: CommentRecord[] = [];
  let page = 1;

  while (true) {
    let data;
    try {
      const response = await withTokenRotation(
        pool,
        (octokit) =>
          octokit.request("GET /repos/{owner}/{repo}/issues/comments", {
            owner: org,
            repo,
            since,
            sort: "updated",
            direction: "desc",
            per_page: REST_PAGE_SIZE,
            page,
          }),
        { label: `comments of ${repo} (page ${page})` },
      );
      data = response.data;
    } catch (error) {
      logger.warn(
        `Giving up on comments for ${repo} after ${comments.length} fetched: ${describeError(error)}`,
      );
      return {
        items: comments,
        partial: true,
        error: describeError(error),
      } satisfies FetchResult<CommentRecord>;
    }

    for (const comment of data) {
      if (comment.user?.login && comment.user?.type === "Bot") {
        botUsers.add(comment.user.login);
      }

      comments.push({
        id: comment.node_id,
        issue_number: comment.issue_url.split("/").pop(),
        body: comment.body,
        created_at: comment.created_at,
        author: comment.user?.login,
        html_url: comment.html_url,
      });
    }

    if (data.length < REST_PAGE_SIZE) break;
    page++;
  }

  logger.info(`Found ${comments.length} comments`);

  return complete(comments);
}

/**
 * Get all issues and assign events from a repository
 * If since is provided, only get issues updated since the date
 * @param octokit - The Octokit instance to use for the API requests
 * @param repo - The repository to get issues from
 * @param since - The date to start getting issues from based on the `updated_at` field (optional)
 * @returns An array of issues
 */
async function getIssues({
  pool,
  org,
  repo,
  since,
  botUsers,
  logger,
}: GitHubApiFetchOptions) {
  type IssueRecord = {
    number: number;
    title: string;
    url: string;
    author: string | null | undefined;
    closed_at: string | null;
    closed: boolean;
    closed_by: string | null;
    created_at: string;
    assign_events: Array<{
      createdAt: string;
      assignee: string | null | undefined;
    }>;
  };

  const issues: IssueRecord[] = [];

  let hasNextPage = true;
  let cursor: string | null = null;
  let pageSizeIndex = 0;

  logger.info(`Fetching issues from ${repo}...`);

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String, $pageSize: Int!) {
        repository(owner: $owner, name: $repo) {
          issues(first: $pageSize, orderBy: { field: UPDATED_AT, direction: DESC }, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              number
              title
              url
              updatedAt
              author {
                __typename
                login
              }
              closed
              closedAt
              createdAt
              timelineItems(itemTypes: [ASSIGNED_EVENT, CLOSED_EVENT], first: 50) {
                nodes {
                  ... on AssignedEvent {
                    createdAt
                    assignee {
                      __typename
                      ... on User { login }
                      ... on Bot { login }
                      ... on Mannequin { login }
                    }
                  }
                  ... on ClosedEvent {
                    createdAt
                    actor {
                      __typename
                      login
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    type IssuePage = {
      repository: {
        issues: {
          nodes: Array<{
            number: number;
            title: string;
            url: string;
            author: { login: string | null; __typename?: string };
            updatedAt: string;
            closedAt: string | null;
            createdAt: string;
            closed: boolean;
            timelineItems: {
              nodes: Array<
                | {
                    __typename?: "AssignedEvent";
                    createdAt: string;
                    actor: { login: string | null; __typename?: string };
                    assignee: { login: string | null; __typename?: string };
                  }
                | {
                    __typename?: "ClosedEvent";
                    createdAt: string;
                    actor: { login: string | null; __typename?: string };
                  }
              >;
            };
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      };
    };

    const pageSize = ISSUE_PAGE_SIZES[pageSizeIndex]!;
    let response: IssuePage;

    try {
      const raw = await withTokenRotation(
        pool,
        (octokit) =>
          octokit.graphql(query, { owner: org, repo, cursor, pageSize }),
        { label: `issues of ${repo}` },
      );
      assertRepositoryPayload(raw, repo, "issues");
      response = raw as IssuePage;
    } catch (error) {
      if (pageSizeIndex < ISSUE_PAGE_SIZES.length - 1) {
        pageSizeIndex++;
        logger.warn(
          `Issue query for ${repo} failed at page size ${pageSize}, retrying with ${ISSUE_PAGE_SIZES[pageSizeIndex]}: ${describeError(error)}`,
        );
        continue;
      }

      logger.warn(
        `Giving up on issues for ${repo} after ${issues.length} fetched${isNodeLimitError(error) ? " (query too large)" : ""}: ${describeError(error)}`,
      );
      return {
        items: issues,
        partial: true,
        error: describeError(error),
      } satisfies FetchResult<IssueRecord>;
    }

    const allIssues = response.repository.issues.nodes;

    for (const issue of allIssues) {
      if (since && new Date(issue.updatedAt) < new Date(since)) {
        return complete(issues);
      }

      if (issue.author?.login && issue.author.__typename === "Bot") {
        botUsers.add(issue.author.login);
      }

      for (const event of issue.timelineItems.nodes) {
        if (
          "assignee" in event &&
          event.assignee?.login &&
          event.assignee.__typename === "Bot"
        ) {
          botUsers.add(event.assignee.login);
        }
        if (event.actor?.login && event.actor.__typename === "Bot") {
          botUsers.add(event.actor.login);
        }
      }

      const assignedEvents =
        issue.timelineItems.nodes?.filter(
          (e): e is Extract<typeof e, { assignee: unknown }> =>
            "assignee" in e && e.createdAt !== undefined,
        ) ?? [];

      const closedEvent = issue.timelineItems.nodes?.find(
        (e): e is Extract<typeof e, { __typename?: "ClosedEvent" }> =>
          !("assignee" in e),
      );

      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        author: issue.author?.login,
        closed_at: issue.closedAt,
        closed: issue.closed,
        closed_by: closedEvent?.actor?.login ?? null,
        created_at: issue.createdAt,
        assign_events: assignedEvents.map((e) => ({
          createdAt: e.createdAt,
          assignee: e.assignee?.login,
        })),
      });
    }

    hasNextPage = response.repository.issues.pageInfo.hasNextPage;
    cursor = response.repository.issues.pageInfo.endCursor;
  }

  return complete(issues);
}

interface CommitRecord {
  commitId: string;
  branchName: string | undefined;
  commitMessage: string;
  committedDate: string | null;
  author: string | null;
  url: string;
  stats: {
    additions?: number;
    deletions?: number;
    total?: number;
  } | null;
}

/**
 * Get all commits from push events of a repository from its events API.
 * @param repo - The repository to get commits from
 * @param since - The date to start getting commits from based on the push event's `created_at` field (optional)
 * @returns An array of commits
 */
async function getCommitsFromPushEvents({
  pool,
  org,
  repo,
  since,
  botUsers,
  logger,
}: GitHubApiFetchOptions): Promise<FetchResult<CommitRecord>> {
  const commits: CommitRecord[] = [];
  let page = 1;

  while (true) {
    let events;
    try {
      const response = await withTokenRotation(
        pool,
        (octokit) =>
          octokit.request("GET /repos/{owner}/{repo}/events", {
            owner: org,
            repo,
            per_page: REST_PAGE_SIZE,
            page,
          }),
        { label: `events of ${repo} (page ${page})` },
      );
      events = response.data;
    } catch (error) {
      logger.warn(
        `Giving up on push events for ${repo} after ${commits.length} commits: ${describeError(error)}`,
      );
      return { items: commits, partial: true, error: describeError(error) };
    }

    for (const event of events) {
      if (
        since &&
        event.created_at &&
        new Date(event.created_at) < new Date(since)
      ) {
        return complete(commits);
      }

      if (event.type !== "PushEvent") {
        continue;
      }

      const payload = event.payload as {
        head?: string;
        before?: string;
        ref?: string;
      };

      if (!payload.head || !payload.before || !payload.ref) {
        continue;
      }

      const branchName = payload.ref.replace("refs/heads/", "");

      try {
        const compareResponse = await withTokenRotation(
          pool,
          (oct) =>
            oct.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
              owner: org,
              repo,
              basehead: `${payload.before}...${payload.head}`,
            }),
          { label: `compare ${payload.before}...${payload.head} in ${repo}` },
        );

        for (const commit of compareResponse.data.commits) {
          if (commit.author?.login && commit.author?.type === "Bot") {
            botUsers.add(commit.author.login);
          }

          commits.push({
            commitId: commit.sha,
            branchName,
            commitMessage: commit.commit.message?.split("\n")[0] ?? "",
            committedDate: commit.commit.committer?.date ?? null,
            author: commit.author?.login ?? null,
            url: commit.html_url,
            stats: commit.stats ?? null,
          });
        }
      } catch (error) {
        // A single unreachable comparison must not discard the rest of the page.
        logger.warn(
          `Failed to compare ${payload.before}...${payload.head} in ${repo}: ${describeError(error)}`,
        );
        continue;
      }
    }

    if (events.length < REST_PAGE_SIZE) break;
    page++;
  }

  return complete(commits);
}

async function getBranchCommits({
  pool,
  org,
  repo,
  branch,
  logger,
  since,
}: GitHubApiFetchOptions): Promise<FetchResult<CommitRecord>> {
  const commits: CommitRecord[] = [];
  let page = 1;

  while (true) {
    let data;
    try {
      const response = await withTokenRotation(
        pool,
        (octokit) =>
          octokit.request("GET /repos/{owner}/{repo}/commits", {
            owner: org,
            repo,
            sha: branch,
            since,
            per_page: REST_PAGE_SIZE,
            page,
          }),
        { label: `commits on ${branch} of ${repo} (page ${page})` },
      );
      data = response.data;
    } catch (error) {
      logger.warn(
        `Giving up on branch commits for ${repo} after ${commits.length} fetched: ${describeError(error)}`,
      );
      return { items: commits, partial: true, error: describeError(error) };
    }

    logger.debug(`Found ${data.length} commits on branch ${branch}`);

    for (const commit of data) {
      commits.push({
        commitId: commit.sha,
        branchName: branch,
        commitMessage: commit.commit.message,
        committedDate: commit.commit.committer?.date ?? null,
        author: commit.author?.login ?? null,
        url: commit.html_url,
        stats: commit.stats ?? null,
      });
    }

    if (data.length < REST_PAGE_SIZE) break;
    page++;
  }

  return complete(commits);
}

function activitiesFromIssues(
  issues: Awaited<ReturnType<typeof getIssues>>["items"],
  repo: string,
) {
  const activities = [];

  // Voluntarily making the slug the key to track the latest assign event for each issue
  // We cannot have multiple duplicate activity entry with same slug in a DB insert statement even though we are doing ON CONFLICT DO UPDATE
  const lastestIssueAssignEvents: Record<string, Omit<Activity, "slug">> = {};

  for (const issue of issues) {
    if (!issue.author) {
      continue;
    }

    // Issue opened
    activities.push({
      slug: `${ActivityDefinition.ISSUE_OPENED}_${repo}#${issue.number}`,
      contributor: issue.author,
      activity_definition: ActivityDefinition.ISSUE_OPENED,
      title: `Opened issue #${issue.number}`,
      text: issue.title,
      occurred_at: new Date(issue.created_at).toISOString(),
      link: issue.url,
      points: null,
      meta: {},
    });

    // Issue assign events
    for (const assignEvent of issue.assign_events) {
      if (!assignEvent.assignee) {
        continue;
      }

      // TODO: figure out how to make the slug not depend on assignee username (since username can change)
      const slug = `${ActivityDefinition.ISSUE_ASSIGNED}_${repo}#${issue.number}_${assignEvent.assignee}`;

      // Skip if the assign event is older than the latest assign event for this issue
      if (
        lastestIssueAssignEvents[slug] &&
        new Date(lastestIssueAssignEvents[slug].occurred_at) >
          new Date(assignEvent.createdAt)
      ) {
        continue;
      }

      lastestIssueAssignEvents[slug] = {
        contributor: assignEvent.assignee,
        activity_definition: ActivityDefinition.ISSUE_ASSIGNED,
        title: `Issue #${issue.number} assigned`,
        text: issue.title,
        occurred_at: assignEvent.createdAt,
        link: issue.url,
        points: null,
        meta: {},
      };
    }

    // Issue closed
    if (issue.closed && issue.closed_at && issue.closed_by) {
      activities.push({
        slug: `${ActivityDefinition.ISSUE_CLOSED}_${repo}#${issue.number}`,
        contributor: issue.closed_by,
        activity_definition: ActivityDefinition.ISSUE_CLOSED,
        title: `Closed issue #${issue.number}`,
        text: issue.title,
        occurred_at: new Date(issue.closed_at).toISOString(),
        link: issue.url,
        points: null,
        meta: {},
      });
    }
  }

  // Append the latest assign events to activities
  for (const [slug, activity] of Object.entries(lastestIssueAssignEvents)) {
    activities.push({ slug, ...activity });
  }

  return activities;
}

function activitiesFromComments(
  comments: Awaited<ReturnType<typeof getComments>>["items"],
  repo: string,
) {
  const activities = [];
  for (const comment of comments) {
    if (!comment.author) {
      continue;
    }

    // Comment created
    activities.push({
      slug: `${ActivityDefinition.COMMENTED}_${repo}#${comment.issue_number}_${comment.id}`,
      contributor: comment.author,
      activity_definition: ActivityDefinition.COMMENTED,
      title: `Commented on #${comment.issue_number}`,
      text: null,
      occurred_at: new Date(comment.created_at).toISOString(),
      link: comment.html_url,
      points: null,
      meta: {},
    });
  }
  return activities;
}

function activitiesFromPullRequests(
  pullRequests: Awaited<ReturnType<typeof getPRsAndReviews>>["items"],
  repo: string,
) {
  const activities = [];

  for (const pullRequest of pullRequests) {
    if (!pullRequest.author) {
      continue;
    }

    // PR opened
    activities.push({
      slug: `${ActivityDefinition.PR_OPENED}_${repo}#${pullRequest.number}`,
      contributor: pullRequest.author,
      activity_definition: ActivityDefinition.PR_OPENED,
      title: `Opened pull request #${pullRequest.number}`,
      text: pullRequest.title,
      occurred_at: new Date(pullRequest.created_at).toISOString(),
      link: pullRequest.url,
      points: null,
      meta: {},
    });

    // PR merged
    if (pullRequest.merged_at && pullRequest.merged_by) {
      activities.push({
        slug: `${ActivityDefinition.PR_MERGED}_${repo}#${pullRequest.number}`,
        contributor: pullRequest.author,
        activity_definition: ActivityDefinition.PR_MERGED,
        title: `Merged pull request #${pullRequest.number}`,
        text: pullRequest.title,
        occurred_at: new Date(pullRequest.merged_at).toISOString(),
        link: pullRequest.url,
        points: null,
        meta: {
          pr_avg_tat:
            new Date(pullRequest.merged_at).getTime() -
            new Date(pullRequest.created_at).getTime(),
        },
      });
    }

    // PR review events
    for (const review of pullRequest.reviews) {
      if (!review.author) {
        continue;
      }

      const title = {
        COMMENTED: `Reviewed PR #${pullRequest.number}`,
        APPROVED: `Approved PR #${pullRequest.number}`,
        CHANGES_REQUESTED: `Changes requested on PR #${pullRequest.number}`,
      };

      // Skip review events such as DISMISSED and PENDING.
      if (!title[review.state as keyof typeof title]) {
        continue;
      }

      const isSelfReview = review.author === pullRequest.author;
      activities.push({
        slug: `${ActivityDefinition.PR_REVIEWED}_${repo}#${pullRequest.number}_${review.state}_${review.id}`,
        contributor: review.author,
        activity_definition: ActivityDefinition.PR_REVIEWED,
        title: title[review.state as keyof typeof title],
        text: pullRequest.title,
        occurred_at: new Date(review.submitted_at!).toISOString(),
        link: review.html_url,
        points: isSelfReview ? 0 : null,
        meta: {},
      });
    }
  }

  return activities;
}

function getActivitiesFromCommits(
  commits: CommitRecord[],
  opts: {
    defaultBranch: string | undefined;
    pointsOnDefaultBranch: number;
    pointsOnNonDefaultBranch: number;
  },
) {
  const activities = [];

  for (const commit of commits) {
    if (!commit.author || !commit.committedDate) {
      continue;
    }

    const isDefaultBranch =
      commit.branchName &&
      opts.defaultBranch &&
      opts.defaultBranch === commit.branchName;

    const points = isDefaultBranch
      ? opts.pointsOnDefaultBranch
      : opts.pointsOnNonDefaultBranch;

    activities.push({
      slug: `${ActivityDefinition.COMMITED}_${commit.branchName}_${commit.commitId}`,
      contributor: commit.author,
      activity_definition: ActivityDefinition.COMMITED,
      title: `Pushed commit to ${commit.branchName}`,
      text: commit.commitMessage,
      occurred_at: new Date(commit.committedDate).toISOString(),
      link: commit.url,
      points,
      meta: {
        branch: commit.branchName,
        stats: commit.stats,
      },
    });
  }

  return activities;
}

async function persistRepoActivities(
  db: PluginContext["db"],
  activities: Activity[],
  logger: Logger,
  defaultRole: string,
): Promise<number> {
  const contributorUsernames = activities.map((a) => a.contributor);
  await addNewContributors(db, contributorUsernames, defaultRole);

  let saved = 0;
  let failed = 0;
  let firstError: Error | undefined;

  for (const activity of activities) {
    try {
      await activityQueries.upsert(db, activity);
      saved++;
    } catch (error) {
      failed++;
      firstError ??= error as Error;
      logger.debug(
        `Failed to upsert activity ${activity.slug}: ${describeError(error)}`,
      );
    }
  }

  if (failed > 0) {
    logger.error(
      `Failed to upsert ${failed} of ${activities.length} activities`,
      firstError,
    );
  }

  return saved;
}

export async function getActivities({ db, config, logger }: PluginContext) {
  const scrapeDays = 7;
  const pool = getOctokitPool(config, logger);
  const org = config.githubOrg as string;
  const dataDir = (config.dataDir as string) || undefined;
  const since = scrapeDays
    ? subDays(new Date(), scrapeDays).toISOString()
    : undefined;

  const activityDefConfig = config.activityDefinition as
    | ActivityDefinitionConfig
    | undefined;
  const disabledSlugs = getDisabledSlugs(activityDefConfig);

  const commitConfig = (activityDefConfig?.[ActivityDefinition.COMMITED] ??
    {}) as CommitActivityDefinitionOverride;
  const pointsOnDefaultBranch = commitConfig.pointsOnDefaultBranch ?? 2;
  const pointsOnNonDefaultBranch = commitConfig.pointsOnNonDefaultBranch ?? 0;

  const contributorBlacklist = new Set(
    (config.blacklist as string[] | undefined) || []
  );

  if (contributorBlacklist.size > 0) {
    logger.info(
      `Blacklisting ${contributorBlacklist.size} contributors: ${Array.from(contributorBlacklist).join(", ")}`
    );
  }

  const botUsers = new Set<string>();

  const repositories = await getRepositories({
    pool,
    org,
    since,
    repo: "",
    botUsers,
    logger,
  });

  logger.info(`Found ${repositories.length} repositories to scrape`);

  const existingProgress = await loadProgress(dataDir);
  const progress: ScrapeProgress = {
    org,
    startedAt: existingProgress?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totalRepos: repositories.length,
    completedRepos: existingProgress?.completedRepos ?? 0,
    partialRepos: existingProgress?.partialRepos ?? 0,
    failedRepos: existingProgress?.failedRepos ?? 0,
    totalActivities: existingProgress?.totalActivities ?? 0,
    repos: existingProgress?.repos ?? {},
  };

  const recountStatuses = () => {
    const values = Object.values(progress.repos);
    progress.completedRepos = values.filter(
      (r) => r.status === "completed",
    ).length;
    progress.partialRepos = values.filter((r) => r.status === "partial").length;
    progress.failedRepos = values.filter((r) => r.status === "failed").length;
  };

  const skippedRepos: string[] = [];
  let processedRepos = 0;

  for (const { name: repository, defaultBranch } of repositories) {
    const existing = progress.repos[repository];
    if (existing?.status === "completed") {
      skippedRepos.push(repository);
      continue;
    }

    progress.repos[repository] = {
      repo: repository,
      status: "in_progress",
      activitiesCount: 0,
    };
    await saveProgress(progress, dataDir);

    logger.info(
      `[${++processedRepos}/${repositories.length - skippedRepos.length}] Scraping ${repository}...`,
    );

    const opts = {
      pool,
      org,
      repo: repository,
      since,
      botUsers,
      logger,
      branch: defaultBranch,
    };

    const commitOpts = {
      defaultBranch,
      pointsOnDefaultBranch,
      pointsOnNonDefaultBranch,
    };

    const sources: Record<string, SourceProgress> = {};

    /**
     * Isolates one data source: an unrecoverable failure degrades only that
     * source, leaving the rest of the repository's activities intact.
     */
    const collect = async <T>(
      name: string,
      fetch: () => Promise<FetchResult<T>>,
      toActivities: (items: T[]) => Activity[],
    ): Promise<Activity[]> => {
      try {
        const result = await fetch();
        sources[name] = result.partial
          ? { status: "partial", error: result.error }
          : { status: "completed" };
        return toActivities(result.items);
      } catch (error) {
        sources[name] = { status: "failed", error: describeError(error) };
        logger.error(
          `Source '${name}' failed for ${repository}`,
          error as Error,
          { repo: repository, source: name },
        );
        return [];
      }
    };

    const collected = await Promise.all([
      collect(
        "issues",
        () => getIssues(opts),
        (items) => activitiesFromIssues(items, repository),
      ),
      collect(
        "comments",
        () => getComments(opts),
        (items) => activitiesFromComments(items, repository),
      ),
      collect(
        "pull_requests",
        () => getPRsAndReviews(opts),
        (items) => activitiesFromPullRequests(items, repository),
      ),
      collect(
        "branch_commits",
        () => getBranchCommits(opts),
        (items) => getActivitiesFromCommits(items, commitOpts),
      ),
      collect(
        "push_commits",
        () =>
          scrapeDays
            ? getCommitsFromPushEvents(opts)
            : Promise.resolve(complete<CommitRecord>([])),
        (items) => getActivitiesFromCommits(items, commitOpts),
      ),
    ]);

    const seenSlugs = new Set<string>();
    const repoActivities: Activity[] = collected
      .flat()
      .filter((a) => !disabledSlugs.has(a.activity_definition))
      .filter((a) => !contributorBlacklist.has(a.contributor))
      .filter((a) => {
        if (seenSlugs.has(a.slug)) return false;
        seenSlugs.add(a.slug);
        return true;
      });

    const defaultRole =
      typeof config.defaultRole === "string"
        ? config.defaultRole
        : "contributor";

    const degradedSources = Object.entries(sources).filter(
      ([, state]) => state.status !== "completed",
    );

    try {
      const saved = await persistRepoActivities(
        db,
        repoActivities,
        logger,
        defaultRole,
      );

      progress.repos[repository] = {
        repo: repository,
        status: degradedSources.length > 0 ? "partial" : "completed",
        activitiesCount: saved,
        completedAt: new Date().toISOString(),
        sources,
        error:
          degradedSources.length > 0
            ? `${degradedSources.length} of ${Object.keys(sources).length} sources degraded`
            : undefined,
      };
      progress.totalActivities += saved;

      if (degradedSources.length > 0) {
        logger.warn(
          `Partially scraped ${repository}: ${saved} activities saved, degraded sources: ${degradedSources.map(([name]) => name).join(", ")}`,
        );
      } else {
        logger.info(`Completed ${repository}: ${saved} activities saved`);
      }
    } catch (error) {
      progress.repos[repository] = {
        repo: repository,
        status: "failed",
        activitiesCount: 0,
        error: describeError(error),
        completedAt: new Date().toISOString(),
        sources,
      };

      logger.error(
        `Failed to persist activities for ${repository}`,
        error as Error,
        { repo: repository },
      );
    }

    recountStatuses();
    await saveProgress(progress, dataDir);
  }

  if (skippedRepos.length > 0) {
    logger.info(
      `Skipped ${skippedRepos.length} already-completed repos: ${skippedRepos.join(", ")}`,
    );
  }

  logger.info(`Found ${botUsers.size} bot users`);
  await updateBotRoles(db, Array.from(botUsers), logger);

  recountStatuses();
  await saveProgress(progress, dataDir);
  logger.info(
    `Scrape finished: ${progress.completedRepos} completed, ${progress.partialRepos} partial, ${progress.failedRepos} failed, ${progress.totalActivities} total activities`,
  );
}
