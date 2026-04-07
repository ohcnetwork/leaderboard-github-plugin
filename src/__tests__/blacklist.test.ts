import { describe, it, expect } from "vitest";

describe("Blacklist Configuration", () => {
  it("should parse blacklist from config as array", () => {
    const config = {
      blacklist: ["user1", "user2", "invalid-email-address"],
    };
    const blacklist = new Set(
      (config.blacklist as string[] | undefined) || []
    );
    expect(blacklist.size).toBe(3);
    expect(blacklist.has("user1")).toBe(true);
    expect(blacklist.has("user2")).toBe(true);
    expect(blacklist.has("invalid-email-address")).toBe(true);
  });

  it("should handle empty blacklist", () => {
    const config = {
      blacklist: [],
    };
    const blacklist = new Set(
      (config.blacklist as string[] | undefined) || []
    );
    expect(blacklist.size).toBe(0);
  });

  it("should handle undefined blacklist", () => {
    const config = {};
    const blacklist = new Set(
      (config.blacklist as string[] | undefined) || []
    );
    expect(blacklist.size).toBe(0);
  });

  it("should filter activities from blacklisted contributors", () => {
    const contributorBlacklist = new Set(["user1", "user2"]);

    const activities = [
      { contributor: "user1", activity_definition: "pr_opened" },
      { contributor: "user3", activity_definition: "pr_opened" },
      { contributor: "user2", activity_definition: "issue_opened" },
      { contributor: "user4", activity_definition: "commented" },
    ];

    const filtered = activities.filter(
      (a) => !contributorBlacklist.has(a.contributor)
    );

    expect(filtered).toHaveLength(2);
    expect(filtered[0]!.contributor).toBe("user3");
    expect(filtered[1]!.contributor).toBe("user4");
  });

  it("should not filter any activities when blacklist is empty", () => {
    const contributorBlacklist = new Set<string>([]);

    const activities = [
      { contributor: "user1", activity_definition: "pr_opened" },
      { contributor: "user2", activity_definition: "issue_opened" },
    ];

    const filtered = activities.filter(
      (a) => !contributorBlacklist.has(a.contributor)
    );

    expect(filtered).toHaveLength(2);
  });

  it("should handle blacklist with single contributor", () => {
    const contributorBlacklist = new Set(["invalid-email-address"]);

    const activities = [
      { contributor: "invalid-email-address", activity_definition: "pr_opened" },
      { contributor: "valid-user", activity_definition: "pr_opened" },
    ];

    const filtered = activities.filter(
      (a) => !contributorBlacklist.has(a.contributor)
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.contributor).toBe("valid-user");
  });

  it("should be case-sensitive when matching contributors", () => {
    const contributorBlacklist = new Set(["User1"]);

    const activities = [
      { contributor: "User1", activity_definition: "pr_opened" },
      { contributor: "user1", activity_definition: "pr_opened" },
    ];

    const filtered = activities.filter(
      (a) => !contributorBlacklist.has(a.contributor)
    );

    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.contributor).toBe("user1");
  });
});
