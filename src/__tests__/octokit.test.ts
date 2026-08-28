import { describe, expect, it } from "vitest";
import {
  GitHubResponseShapeError,
  describeError,
  isNodeLimitError,
  isRateLimitError,
  isTransientError,
} from "../octokit";

describe("isTransientError", () => {
  it("classifies GitHub's GraphQL timeout message as transient", () => {
    const error = new Error(
      "We couldn't respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists.",
    );
    expect(isTransientError(error)).toBe(true);
  });

  it("classifies GitHub's HTML error page as transient", () => {
    const error = new Error(
      "<!DOCTYPE html>\n<html>\n  <head>\n    <title>Server Error</title>",
    );
    expect(isTransientError(error)).toBe(true);
  });

  it("classifies 5xx statuses as transient", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTransientError({ status })).toBe(true);
    }
  });

  it("classifies network failures as transient", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
  });

  it("classifies a degraded GraphQL payload as transient", () => {
    const error = new GitHubResponseShapeError(
      "GraphQL response for care_fe did not include repository.pullRequests",
    );
    expect(isTransientError(error)).toBe(true);
  });

  it("does not classify client errors as transient", () => {
    expect(isTransientError({ status: 404, message: "Not Found" })).toBe(false);
    expect(isTransientError({ status: 401, message: "Bad credentials" })).toBe(
      false,
    );
  });

  it("keeps rate limits out of the transient bucket", () => {
    const error = { status: 429, message: "API rate limit exceeded" };
    expect(isRateLimitError(error)).toBe(true);
  });
});

describe("isNodeLimitError", () => {
  it("detects GitHub's node limit rejection", () => {
    expect(
      isNodeLimitError(
        new Error("Request failed: MAX_NODE_LIMIT_EXCEEDED for query"),
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isNodeLimitError(new Error("Not Found"))).toBe(false);
  });
});

describe("describeError", () => {
  it("collapses whitespace and truncates long payloads", () => {
    const html = `<!DOCTYPE html>\n${"x".repeat(500)}`;
    const described = describeError(html);

    expect(described.length).toBeLessThanOrEqual(201);
    expect(described).not.toContain("\n");
    expect(described.endsWith("…")).toBe(true);
  });

  it("leaves short messages intact", () => {
    expect(describeError(new Error("Not Found"))).toBe("Not Found");
  });
});
