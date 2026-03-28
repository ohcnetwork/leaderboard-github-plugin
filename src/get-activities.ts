import { subDays } from "date-fns";
import { activityQueries, Logger } from "@ohcnetwork/leaderboard-api";
import { PluginContext } from "@ohcnetwork/leaderboard-api";
import { Activity } from "@ohcnetwork/leaderboard-api";
import { ActivityDefinition } from "./activity";
import {
  OctokitPool,
  getOctokitPool,
  withTokenRotation,
  isRateLimitError,
} from "./octokit";
import { addNewContributors, updateBotRoles } from "@/src/db";
import { writeFile, readFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

interface GitHubApiFetchOptions {
  pool: OctokitPool;
  org: string;
  repo: string;
  since?: string;
  branch?: string;
  botUsers: Set<string>;
  logger: Logger;
}

interface RepoProgress {
  repo: string;
  status: "completed" | "failed" | "in_progress";
  activitiesCount: number;
  error?: string;
  completedAt?: string;
}

interface ScrapeProgress {
  org: string;
  startedAt: string;
  updatedAt: string;
  totalRepos: number;
  completedRepos: number;
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

async function writeProgressMarkdown(
  progress: ScrapeProgress,
  dataDir?: string,
): Promise<void> {
  const completedRepos = Object.values(progress.repos).filter(
    (r) => r.status === "completed",
  );
  const failedRepos = Object.values(progress.repos).filter(
    (r) => r.status === "failed",
  );
  const pendingCount =
    progress.totalRepos - completedRepos.length - failedRepos.length;

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
    `| Completed | ${completedRepos.length} |`,
    `| Failed | ${failedRepos.length} |`,
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
    const icon =
      r.status === "completed" ? "✅" : r.status === "failed" ? "❌" : "⏳";
    const err = r.error ? ` (${r.error})` : "";
    lines.push(
      `| ${i++} | ${r.repo} | ${icon} ${r.status}${err} | ${r.activitiesCount} | ${r.completedAt ?? "-"} |`,
    );
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
        sort: "pushed",
      },
    )) {
      logger.info(`Found ${response.data.length} repositories`);
      for (const repo of response.data) {
        if (
          since &&
          repo.pushed_at &&
          new Date(repo.pushed_at) < new Date(since)
        ) {
          return repos;
        }

        if (!repo.pushed_at) continue;

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
  const pullRequests = [];

  let hasNextPage = true;
  let cursor: string | null = null;

  logger.info(`Fetching pull requests from ${repo}...`);

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(
            first: 100
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
              reviews(first: 100) {
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

    const response: {
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
    } = await withTokenRotation(pool, (octokit) =>
      octokit.graphql(query, {
        owner: org,
        repo,
        cursor,
      }),
    );

    const prs = response.repository.pullRequests.nodes;

    logger.info(`Found ${prs.length} pull requests`);

    for (const pr of prs) {
      if (since && pr.updatedAt && new Date(pr.updatedAt) < new Date(since)) {
        return pullRequests;
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

  return pullRequests;
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

  const comments = (await withTokenRotation(pool, (octokit) =>
    octokit.paginate(
      "GET /repos/{owner}/{repo}/issues/comments",
      { owner: org, repo, since, sort: "updated", direction: "desc" },
      (response: any) =>
        response.data.map((comment: any) => {
          if (comment.user?.login && comment.user?.type === "Bot") {
            botUsers.add(comment.user.login);
          }

          return {
            id: comment.node_id,
            issue_number: comment.issue_url.split("/").pop(),
            body: comment.body,
            created_at: comment.created_at,
            author: comment.user?.login,
            html_url: comment.html_url,
          };
        }),
    ),
  )) as Array<{
    id: string;
    issue_number: string;
    body: string;
    created_at: string;
    author: string | undefined;
    html_url: string;
  }>;

  logger.info(`Found ${comments.length} comments`);

  return comments;
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
  const issues = [];

  let hasNextPage = true;
  let cursor: string | null = null;

  logger.info(`Fetching issues from ${repo}...`);

  while (hasNextPage) {
    const query = `
      query($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          issues(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }, after: $cursor) {
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

    const response: {
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
    } = await withTokenRotation(pool, (octokit) =>
      octokit.graphql(query, { owner: org, repo, cursor }),
    );

    const allIssues = response.repository.issues.nodes;

    for (const issue of allIssues) {
      if (since && new Date(issue.updatedAt) < new Date(since)) {
        return issues;
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

  return issues;
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
}: GitHubApiFetchOptions): ReturnType<typeof getBranchCommits> {
  return withTokenRotation(pool, async (octokit) => {
    const commits = [];

    for await (const response of octokit.paginate.iterator(
      "GET /repos/{owner}/{repo}/events",
      {
        owner: org,
        repo,
        per_page: 100,
      },
    )) {
      for (const event of response.data) {
        if (
          since &&
          event.created_at &&
          new Date(event.created_at) < new Date(since)
        ) {
          return commits;
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
          const compareResponse: any = await withTokenRotation(pool, (oct) =>
            oct.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
              owner: org,
              repo,
              basehead: `${payload.before}...${payload.head}`,
            }),
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
            });
          }
        } catch (error) {
          if (isRateLimitError(error)) throw error;
          logger.error(
            `Failed to compare ${payload.before}...${payload.head} in ${repo}:`,
            error as Error,
          );
          continue;
        }
      }
    }

    return commits;
  });
}

async function getBranchCommits({
  pool,
  org,
  repo,
  branch,
}: GitHubApiFetchOptions) {
  return withTokenRotation(pool, (octokit) =>
    octokit.paginate(
      "GET /repos/{owner}/{repo}/commits",
      { owner: org, repo, sha: branch },
      (response: any) =>
        response.data.map((commit: any) => ({
          commitId: commit.sha,
          branchName: branch,
          commitMessage: commit.commit.message,
          committedDate: commit.commit.committer?.date ?? null,
          author: commit.author?.login ?? null,
          url: commit.html_url,
        })),
    ),
  ) as Promise<
    Array<{
      commitId: string;
      branchName: string | undefined;
      commitMessage: string;
      committedDate: string | null;
      author: string | null;
      url: string;
    }>
  >;
}

function activitiesFromIssues(
  issues: Awaited<ReturnType<typeof getIssues>>,
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
      occured_at: new Date(issue.created_at).toISOString(),
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
        new Date(lastestIssueAssignEvents[slug].occured_at) >
          new Date(assignEvent.createdAt)
      ) {
        continue;
      }

      lastestIssueAssignEvents[slug] = {
        contributor: assignEvent.assignee,
        activity_definition: ActivityDefinition.ISSUE_ASSIGNED,
        title: `Issue #${issue.number} assigned`,
        text: issue.title,
        occured_at: assignEvent.createdAt,
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
        occured_at: new Date(issue.closed_at).toISOString(),
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
  comments: Awaited<ReturnType<typeof getComments>>,
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
      occured_at: new Date(comment.created_at).toISOString(),
      link: comment.html_url,
      points: null,
      meta: {},
    });
  }
  return activities;
}

function activitiesFromPullRequests(
  pullRequests: Awaited<ReturnType<typeof getPRsAndReviews>>,
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
      occured_at: new Date(pullRequest.created_at).toISOString(),
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
        occured_at: new Date(pullRequest.merged_at).toISOString(),
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
        occured_at: new Date(review.submitted_at!).toISOString(),
        link: review.html_url,
        points: isSelfReview ? 0 : null,
        meta: {},
      });
    }
  }

  return activities;
}

function getActivitiesFromCommits(
  commits: Awaited<ReturnType<typeof getCommitsFromPushEvents>>,
) {
  const activities = [];

  for (const commit of commits) {
    if (!commit.author || !commit.committedDate) {
      continue;
    }

    activities.push({
      slug: `${ActivityDefinition.COMMITED}_${commit.branchName}_${commit.commitId}`,
      contributor: commit.author,
      activity_definition: ActivityDefinition.COMMITED,
      title: `Pushed commit to ${commit.branchName}`,
      text: commit.commitMessage,
      occured_at: new Date(commit.committedDate).toISOString(),
      link: commit.url,
      points: null,
      meta: {},
    });
  }

  return activities;
}

async function persistRepoActivities(
  db: PluginContext["db"],
  activities: Activity[],
  logger: Logger,
  defaultRole: string | null,
): Promise<number> {
  const contributorUsernames = activities.map((a) => a.contributor);
  await addNewContributors(db, contributorUsernames, defaultRole);

  let saved = 0;
  for (const activity of activities) {
    try {
      await activityQueries.upsert(db, activity);
      saved++;
    } catch (error) {
      logger.error(
        `Failed to upsert activity: ${activity.slug}`,
        error as Error,
      );
    }
  }
  return saved;
}

export async function getActivities({ db, config, logger }: PluginContext) {
  const scrapeDays = 1;
  const pool = getOctokitPool(config, logger);
  const org = config.githubOrg as string;
  const dataDir = (config.dataDir as string) || undefined;
  const since = scrapeDays
    ? subDays(new Date(), scrapeDays).toISOString()
    : undefined;

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
    failedRepos: existingProgress?.failedRepos ?? 0,
    totalActivities: existingProgress?.totalActivities ?? 0,
    repos: existingProgress?.repos ?? {},
  };

  const skippedRepos: string[] = [];

  for (const { name: repository } of repositories) {
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
      `[${Object.values(progress.repos).filter((r) => r.status === "completed").length + 1}/${repositories.length}] Scraping ${repository}...`,
    );

    try {
      const opts = { pool, org, repo: repository, since, botUsers, logger };

      const repoActivities: Activity[] = await Promise.all([
        getIssues(opts),
        getComments(opts),
        getPRsAndReviews(opts),
        scrapeDays ? getCommitsFromPushEvents(opts) : getBranchCommits(opts),
      ]).then(([issues, comments, pullRequests, commits]) => [
        ...activitiesFromIssues(issues, repository),
        ...activitiesFromComments(comments, repository),
        ...activitiesFromPullRequests(pullRequests, repository),
        ...getActivitiesFromCommits(commits),
      ]);

      const defaultRole =
        typeof config.defaultRole === "string" ? config.defaultRole : null;

      const saved = await persistRepoActivities(
        db,
        repoActivities,
        logger,
        defaultRole,
      );

      progress.repos[repository] = {
        repo: repository,
        status: "completed",
        activitiesCount: saved,
        completedAt: new Date().toISOString(),
      };
      progress.completedRepos = Object.values(progress.repos).filter(
        (r) => r.status === "completed",
      ).length;
      progress.totalActivities += saved;

      logger.info(`Completed ${repository}: ${saved} activities saved`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      progress.repos[repository] = {
        repo: repository,
        status: "failed",
        activitiesCount: 0,
        error: errMsg.slice(0, 200),
        completedAt: new Date().toISOString(),
      };
      progress.failedRepos = Object.values(progress.repos).filter(
        (r) => r.status === "failed",
      ).length;

      logger.error(`Failed to scrape ${repository}: ${errMsg}`);
    }

    await saveProgress(progress, dataDir);
  }

  if (skippedRepos.length > 0) {
    logger.info(
      `Skipped ${skippedRepos.length} already-completed repos: ${skippedRepos.join(", ")}`,
    );
  }

  logger.info(`Found ${botUsers.size} bot users`);
  await updateBotRoles(db, Array.from(botUsers), logger);

  await saveProgress(progress, dataDir);
  logger.info(
    `Scrape finished: ${progress.completedRepos} completed, ${progress.failedRepos} failed, ${progress.totalActivities} total activities`,
  );
}
