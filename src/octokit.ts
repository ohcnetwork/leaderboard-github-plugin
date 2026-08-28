import { Octokit as OctokitCore } from "@octokit/core";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { paginateGraphQL } from "@octokit/plugin-paginate-graphql";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { PluginConfig } from "@ohcnetwork/leaderboard-api";
import type { Logger } from "@ohcnetwork/leaderboard-api";

const Octokit = OctokitCore.plugin(
  paginateRest,
  paginateGraphQL,
  restEndpointMethods,
);
type Octokit = InstanceType<typeof Octokit>;
export type { Octokit };

interface TokenState {
  token: string;
  octokit: Octokit;
  rateLimitedUntil: number;
}

let pool: OctokitPool | null = null;

export class OctokitPool {
  private tokens: TokenState[];
  private currentIndex: number = 0;
  readonly logger: Logger;

  constructor(tokens: string[], logger: Logger) {
    if (tokens.length === 0) {
      throw new Error("At least one GitHub token is required");
    }

    this.logger = logger;
    this.tokens = tokens.map((token) => ({
      token,
      octokit: new Octokit({ auth: token }),
      rateLimitedUntil: 0,
    }));

    logger.info(`Initialized Octokit pool with ${tokens.length} token(s)`);
  }

  get current(): Octokit {
    return this.tokens[this.currentIndex]!.octokit;
  }

  get currentTokenIndex(): number {
    return this.currentIndex;
  }

  get size(): number {
    return this.tokens.length;
  }

  markRateLimited(retryAfterMs: number = 3600_000): void {
    const state = this.tokens[this.currentIndex]!;
    state.rateLimitedUntil = Date.now() + retryAfterMs;
    this.logger.warn(
      `Token #${this.currentIndex + 1} rate-limited for ${Math.ceil(retryAfterMs / 1000)}s`,
    );
  }

  rotate(): boolean {
    const now = Date.now();
    const startIndex = this.currentIndex;

    for (let i = 1; i <= this.tokens.length; i++) {
      const candidateIndex = (startIndex + i) % this.tokens.length;
      const candidate = this.tokens[candidateIndex]!;

      if (candidate.rateLimitedUntil <= now) {
        this.currentIndex = candidateIndex;
        this.logger.info(
          `Rotated to token #${candidateIndex + 1}/${this.tokens.length}`,
        );
        return true;
      }
    }

    return false;
  }

  earliestAvailableAt(): number {
    const now = Date.now();
    let earliest = Infinity;

    for (const t of this.tokens) {
      if (t.rateLimitedUntil <= now) return 0;
      earliest = Math.min(earliest, t.rateLimitedUntil);
    }

    return earliest;
  }
}

/**
 * Raised when GitHub answers with a well-formed HTTP response whose payload is
 * missing the data the query asked for (degraded/partial responses).
 */
export class GitHubResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubResponseShapeError";
  }
}

function parseRetryAfter(error: unknown): number {
  const err = error as {
    response?: {
      headers?: Record<string, string>;
      data?: { message?: string };
    };
    status?: number;
  };

  const retryHeader = err.response?.headers?.["retry-after"];
  if (retryHeader) {
    const seconds = parseInt(retryHeader, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }

  const resetHeader = err.response?.headers?.["x-ratelimit-reset"];
  if (resetHeader) {
    const resetTime = parseInt(resetHeader, 10) * 1000;
    const waitMs = resetTime - Date.now();
    if (waitMs > 0) return waitMs;
  }

  return 3600_000;
}

/**
 * Determines if an error is a GitHub rate limit error (REST or GraphQL).
 */
export function isRateLimitError(error: unknown): boolean {
  const err = error as {
    status?: number;
    message?: string;
    response?: { data?: { message?: string } };
  };

  if (err.status === 429) return true;

  if (err.status === 403) {
    const message = err.response?.data?.message ?? "";
    if (
      message.includes("rate limit") ||
      message.includes("abuse detection") ||
      message.includes("secondary rate limit") ||
      message.includes("API rate limit exceeded")
    ) {
      return true;
    }
  }

  const message = err.message ?? "";
  if (
    message.includes("quota exhausted") ||
    message.includes("rate limit") ||
    message.includes("Request quota exhausted")
  ) {
    return true;
  }

  return false;
}

const TRANSIENT_STATUSES = new Set([408, 500, 502, 503, 504, 520, 522, 524]);

const TRANSIENT_MESSAGE_PATTERNS = [
  "couldn't respond to your request in time",
  "<!doctype html",
  "timeout",
  "timed out",
  "socket hang up",
  "econnreset",
  "etimedout",
  "econnrefused",
  "eai_again",
  "fetch failed",
  "terminated",
  "bad gateway",
  "service unavailable",
  "server error",
];

/**
 * Errors worth retrying: GitHub availability blips, query timeouts, and the
 * HTML error pages GitHub serves instead of JSON when a backend is degraded.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof GitHubResponseShapeError) return true;

  const err = error as {
    status?: number;
    message?: string;
    response?: { status?: number };
  };

  const status = err.status ?? err.response?.status;
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;

  const message = (err.message ?? "").toLowerCase();
  return TRANSIENT_MESSAGE_PATTERNS.some((pattern) =>
    message.includes(pattern),
  );
}

/**
 * GitHub rejected the GraphQL query because it asked for too many nodes.
 * Retrying is pointless unless the page size shrinks first.
 */
export function isNodeLimitError(error: unknown): boolean {
  const message = (error as { message?: string }).message ?? "";
  return (
    message.includes("MAX_NODE_LIMIT_EXCEEDED") ||
    message.includes("exceeds the maximum number of nodes")
  );
}

/**
 * Collapses an error into a single short line — GitHub's HTML error pages are
 * kilobytes long and would otherwise flood logs and error reports.
 */
export function describeError(error: unknown, maxLength = 200): string {
  const raw =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength)}…`
    : collapsed;
}

const DEFAULT_MAX_TRANSIENT_RETRIES = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

function backoffDelay(attempt: number): number {
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return ceiling / 2 + Math.random() * (ceiling / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WithTokenRotationOptions {
  maxTransientRetries?: number;
  /** Human-readable description of the request, used in retry logs. */
  label?: string;
}

export async function withTokenRotation<T>(
  pool: OctokitPool,
  fn: (octokit: Octokit) => Promise<T>,
  options: WithTokenRotationOptions = {},
): Promise<T> {
  const maxTransientRetries =
    options.maxTransientRetries ?? DEFAULT_MAX_TRANSIENT_RETRIES;
  const label = options.label ? ` for ${options.label}` : "";
  let transientAttempts = 0;

  while (true) {
    try {
      return await fn(pool.current);
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAfterMs = parseRetryAfter(error);
        pool.markRateLimited(retryAfterMs);

        if (pool.rotate()) {
          continue;
        }

        const waitUntil = pool.earliestAvailableAt();
        const waitMs = waitUntil - Date.now();
        if (waitMs > 0) {
          pool.logger.warn(
            `All ${pool.size} tokens rate-limited. Waiting ${Math.ceil(waitMs / 1000)}s for next available token...`,
          );
          await sleep(waitMs + 1000);
        }
        continue;
      }

      if (isTransientError(error) && transientAttempts < maxTransientRetries) {
        const delay = backoffDelay(transientAttempts);
        transientAttempts++;
        pool.logger.warn(
          `Transient GitHub error${label} (attempt ${transientAttempts}/${maxTransientRetries}), retrying in ${Math.ceil(delay / 1000)}s: ${describeError(error)}`,
        );
        await sleep(delay);
        continue;
      }

      throw error;
    }
  }
}

export function getOctokitPool(
  config: PluginConfig,
  logger: Logger,
): OctokitPool {
  if (pool) return pool;

  const githubOrg = config.githubOrg;
  if (!githubOrg) {
    throw new Error("'githubOrg' is not set in the plugin config");
  }

  const tokens: string[] = [];

  if (Array.isArray(config.githubTokens)) {
    for (const t of config.githubTokens) {
      if (typeof t === "string" && t.trim()) tokens.push(t.trim());
    }
  }

  if (typeof config.githubToken === "string" && config.githubToken.trim()) {
    const single = config.githubToken.trim();
    if (!tokens.includes(single)) tokens.push(single);
  }

  if (tokens.length === 0) {
    throw new Error(
      "'githubToken' or 'githubTokens' must be set in the plugin config",
    );
  }

  pool = new OctokitPool(tokens, logger);
  return pool;
}

export function _resetPool(): void {
  pool = null;
}
