/**
 * Tests for leaderboard-github-plugin plugin
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, initializeSchema } from "@leaderboard/api";
import type { Database } from "@leaderboard/api";
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

    if (plugin.setup) {
      await plugin.setup({
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
    }

    // TODO: Add assertions for your activity definitions
  });

  it("should scrape data", async () => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    // Setup first if needed
    if (plugin.setup) {
      await plugin.setup({
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
    }

    // Then scrape
    await plugin.scrape({
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

    // TODO: Add assertions for scraped data
  });
});
