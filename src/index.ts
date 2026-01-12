/**
 * Leaderboard github plugin
 */

import { getActivities } from "@/src/get-activities";
import type { Plugin, PluginContext } from "@ohcnetwork/leaderboard-api";
import { ActivityDefinition } from "./activity";

const plugin: Plugin = {
  name: "@leaderboard/plugin-leaderboard-github-plugin",
  version: "0.1.0",

  async setup(ctx: PluginContext) {
    ctx.logger.info("Setting up leaderboard-github-plugin plugin...");

    // Define activity types
    const activityDefinitions = [
      {
        slug: ActivityDefinition.COMMENTED,
        name: "Commented",
        description: "Commented on an Issue/PR",
        points: 0,
        icon: "message-circle",
      },
      {
        slug: ActivityDefinition.ISSUE_ASSIGNED,
        name: "Issue Assigned",
        description: "Got an issue assigned",
        points: 1,
        icon: "user-round-check",
      },
      {
        slug: ActivityDefinition.PR_REVIEWED,
        name: "PR Reviewed",
        description: "Reviewed a Pull Request",
        points: 2,
        icon: "eye",
      },
      {
        slug: ActivityDefinition.ISSUE_OPENED,
        name: "Issue Opened",
        description: "Raised an Issue",
        points: 2,
        icon: "circle-dot",
      },
      {
        slug: ActivityDefinition.PR_OPENED,
        name: "PR Opened",
        description: "Opened a Pull Request",
        points: 1,
        icon: "git-pull-request-create-arrow",
      },
      {
        slug: ActivityDefinition.PR_MERGED,
        name: "PR Merged",
        description: "Merged a Pull Request",
        points: 7,
        icon: "git-merge",
      },
      {
        slug: ActivityDefinition.PR_COLLABORATED,
        name: "PR Collaborated",
        description: "Collaborated on a Pull Request",
        points: 2,
        icon: null,
      },
      {
        slug: ActivityDefinition.ISSUE_CLOSED,
        name: "Issue Closed",
        description: "Closed an Issue",
        points: 0,
        icon: null,
      },
      {
        slug: ActivityDefinition.COMMITED,
        name: "Commit Created",
        description: "Pushed a commit",
        points: 0,
        icon: "git-commit-horizontal",
      },
    ];

    // Insert activity definitions
    for (const activity of activityDefinitions) {
      await ctx.db.execute(
        `INSERT OR IGNORE INTO activity_definition
         (slug, name, description, points, icon)
         VALUES (?, ?, ?, ?, ?)`,
        [
          activity.slug,
          activity.name,
          activity.description,
          activity.points,
          activity.icon,
        ]
      );
    }

    ctx.logger.info("Setup complete");
  },

  async scrape(ctx: PluginContext) {
    ctx.logger.info("Starting leaderboard-github-plugin data scraping...");

    await getActivities(ctx);
    ctx.logger.info("Scraping complete");
  },
};

export default plugin;
