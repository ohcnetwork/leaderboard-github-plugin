/**
 * Tests for leaderboard-github-plugin plugin
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, initializeSchema } from "@ohcnetwork/leaderboard-api";
import type { Database } from "@ohcnetwork/leaderboard-api";
import plugin from "../index.js";

describe("Leaderboard-github-plugin Plugin", () => {
  let db: Database;

  beforeEach(async () => {
    db = createDatabase(":memory:");
    await initializeSchema(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("should have correct plugin metadata", () => {
    expect(plugin.name).toBe("@leaderboard/plugin-leaderboard-github-plugin");
    expect(plugin.version).toBeTruthy();
    expect(plugin.scrape).toBeDefined();
  });

  it("should setup activity definitions", async () => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    await plugin.setup!({
      db,
      config: {},
      orgConfig: {
        name: "Test Org",
        description: "Test",
        url: "https://test.com",
        logo_url: "https://test.com/logo.png",
      },
      logger,
    });

    const result = await db.execute(
      "SELECT slug FROM activity_definition ORDER BY slug",
    );
    expect(result.rows.length).toBe(9);
  });

  it("should throw when scraping without githubOrg config", async () => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    await expect(
      plugin.scrape({
        db,
        config: {},
        orgConfig: {
          name: "Test Org",
          description: "Test",
          url: "https://test.com",
          logo_url: "https://test.com/logo.png",
        },
        logger,
      }),
    ).rejects.toThrow("githubOrg");
  });
});
