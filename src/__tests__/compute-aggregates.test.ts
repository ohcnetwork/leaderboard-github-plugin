import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDatabase,
  initializeSchema,
  activityQueries,
  contributorQueries,
  contributorAggregateQueries,
  contributorAggregateDefinitionQueries,
  globalAggregateQueries,
} from "@ohcnetwork/leaderboard-api";
import type {
  Database,
  PluginContext,
  NumberAggregateValue,
} from "@ohcnetwork/leaderboard-api";
import { subDays } from "date-fns";
import { computeAggregates } from "../compute-aggregates";
import { ActivityDefinition } from "../activity";

function makeCtx(db: Database): PluginContext {
  return {
    db,
    config: {},
    orgConfig: {
      name: "Test Org",
      description: "Test",
      url: "https://test.com",
      logo_url: "https://test.com/logo.png",
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

async function seedContributor(db: Database, username: string) {
  await contributorQueries.insertOrIgnore(db, {
    username,
    name: null,
    role: "contributor",
    title: null,
    bio: null,
    joining_date: null,
    avatar_url: null,
    social_profiles: null,
    meta: null,
  });
}

async function seedActivityDefinition(db: Database) {
  await db.execute(
    `INSERT OR IGNORE INTO activity_definition (slug, name, description, points, icon)
     VALUES (?, ?, ?, ?, ?)`,
    [ActivityDefinition.PR_MERGED, "PR Merged", "Merged a PR", 5, "git-merge"],
  );
}

async function seedAggregateDefinition(db: Database) {
  await contributorAggregateDefinitionQueries.upsert(db, {
    slug: "pr_avg_turn_around_time",
    name: "Avg PR Turn Around Time",
    description: "Average time taken for PRs to get merged",
  });
}

async function seedPrMergedActivity(
  db: Database,
  opts: {
    slug: string;
    contributor: string;
    occurredAt: Date;
    prAvgTat: number | null;
  },
) {
  await activityQueries.upsert(db, {
    slug: opts.slug,
    contributor: opts.contributor,
    activity_definition: ActivityDefinition.PR_MERGED,
    title: "Merged PR",
    occurred_at: opts.occurredAt.toISOString(),
    link: null,
    text: null,
    points: 5,
    meta: opts.prAvgTat !== null ? { pr_avg_tat: opts.prAvgTat } : {},
  });
}

describe("computeAggregates", () => {
  let db: Database;

  beforeEach(async () => {
    db = createDatabase(":memory:");
    await initializeSchema(db);
    await seedActivityDefinition(db);
    await seedAggregateDefinition(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe("contributor pr_avg_turn_around_time", () => {
    it("computes average TAT for a single contributor with one PR", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 3600000, // 1 hour
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );

      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.type).toBe("number");
      expect(value.value).toBe(3600000);
      expect(value.unit).toBe("ms");
      expect(value.format).toBe("duration");
    });

    it("computes average TAT for a contributor with multiple PRs", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 2000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 4000000,
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );

      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(3000000); // (2M + 4M) / 2
    });

    it("computes separate averages per contributor", async () => {
      await seedContributor(db, "alice");
      await seedContributor(db, "bob");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 1000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "bob",
        occurredAt: new Date(),
        prAvgTat: 5000000,
      });

      await computeAggregates(makeCtx(db));

      const aliceAgg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );
      const bobAgg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "bob",
          "pr_avg_turn_around_time",
        );

      expect((aliceAgg!.value as NumberAggregateValue).value).toBe(1000000);
      expect((bobAgg!.value as NumberAggregateValue).value).toBe(5000000);
    });

    it("skips activities with no pr_avg_tat in meta", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: null, // no TAT
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );
      expect(agg).toBeNull();
    });

    it("only averages activities that have pr_avg_tat, ignoring those without", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 6000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: null,
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(6000000);
      expect(agg!.meta!.pr_count).toBe(1);
    });

    it("stores pr_count in meta", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 1000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 3000000,
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );
      expect(agg!.meta!.pr_count).toBe(2);
    });

    it("produces no aggregates when there are no activities", async () => {
      await computeAggregates(makeCtx(db));

      const all = await contributorAggregateQueries.getAll(db);
      expect(all).toHaveLength(0);
    });

    it("updates aggregate on re-computation", async () => {
      await seedContributor(db, "alice");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 1000000,
      });

      await computeAggregates(makeCtx(db));

      // Add another activity and recompute
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: new Date(),
        prAvgTat: 3000000,
      });

      await computeAggregates(makeCtx(db));

      const agg =
        await contributorAggregateQueries.getByContributorAndAggregate(
          db,
          "alice",
          "pr_avg_turn_around_time",
        );
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(2000000); // (1M + 3M) / 2
      expect(agg!.meta!.pr_count).toBe(2);
    });
  });

  describe("global pr_avg_turn_around_time aggregates", () => {
    const now = new Date();

    it("computes all-time global average across all contributors", async () => {
      await seedContributor(db, "alice");
      await seedContributor(db, "bob");
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 400),
        prAvgTat: 2000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "bob",
        occurredAt: subDays(now, 3),
        prAvgTat: 4000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(3000000); // (2M + 4M) / 2
      expect(value.unit).toBe("ms");
      expect(value.format).toBe("duration");
      expect(agg!.meta!.pr_count).toBe(2);
    });

    it("computes weekly global average (last 7 days only)", async () => {
      await seedContributor(db, "alice");
      await seedContributor(db, "bob");

      // Inside the week
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 2),
        prAvgTat: 1000000,
      });
      // Outside the week
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "bob",
        occurredAt: subDays(now, 10),
        prAvgTat: 9000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_week",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(1000000); // only the recent one
      expect(agg!.meta!.pr_count).toBe(1);
    });

    it("computes monthly global average (last 30 days only)", async () => {
      await seedContributor(db, "alice");
      await seedContributor(db, "bob");

      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 5),
        prAvgTat: 2000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "bob",
        occurredAt: subDays(now, 20),
        prAvgTat: 4000000,
      });
      // Outside the month
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#3",
        contributor: "alice",
        occurredAt: subDays(now, 60),
        prAvgTat: 99000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_month",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(3000000); // (2M + 4M) / 2
      expect(agg!.meta!.pr_count).toBe(2);
    });

    it("computes yearly global average (last 365 days only)", async () => {
      await seedContributor(db, "alice");

      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 100),
        prAvgTat: 5000000,
      });
      // Outside the year
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: subDays(now, 400),
        prAvgTat: 99000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_year",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(5000000);
      expect(agg!.meta!.pr_count).toBe(1);
    });

    it("computes previous week (7-14 days ago)", async () => {
      await seedContributor(db, "alice");

      // Inside previous week (7-14 days ago)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 10),
        prAvgTat: 8000000,
      });
      // Inside current week (should be excluded)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: subDays(now, 3),
        prAvgTat: 1000000,
      });
      // Before previous week (should be excluded)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#3",
        contributor: "alice",
        occurredAt: subDays(now, 20),
        prAvgTat: 99000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_week",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(8000000);
      expect(agg!.meta!.pr_count).toBe(1);
    });

    it("computes previous month (30-60 days ago)", async () => {
      await seedContributor(db, "alice");

      // Inside previous month (30-60 days ago)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 40),
        prAvgTat: 3000000,
      });
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: subDays(now, 50),
        prAvgTat: 7000000,
      });
      // Inside current month (should be excluded)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#3",
        contributor: "alice",
        occurredAt: subDays(now, 10),
        prAvgTat: 1000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_month",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(5000000); // (3M + 7M) / 2
      expect(agg!.meta!.pr_count).toBe(2);
    });

    it("computes previous year (365-730 days ago)", async () => {
      await seedContributor(db, "alice");

      // Inside previous year (365-730 days ago)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 500),
        prAvgTat: 6000000,
      });
      // Inside current year (should be excluded)
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: subDays(now, 100),
        prAvgTat: 1000000,
      });

      await computeAggregates(makeCtx(db));

      const agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_year",
      );
      expect(agg).not.toBeNull();
      const value = agg!.value as NumberAggregateValue;
      expect(value.value).toBe(6000000);
      expect(agg!.meta!.pr_count).toBe(1);
    });

    it("skips global aggregate when no activities fall in the window", async () => {
      await seedContributor(db, "alice");

      // Only old activity, nothing in the last week
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 100),
        prAvgTat: 5000000,
      });

      await computeAggregates(makeCtx(db));

      const weekAgg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_week",
      );
      expect(weekAgg).toBeNull();

      // But all-time and year should exist
      const allTimeAgg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time",
      );
      expect(allTimeAgg).not.toBeNull();
    });

    it("produces no global aggregates when there are no activities", async () => {
      await computeAggregates(makeCtx(db));

      const allTime = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time",
      );
      const week = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_week",
      );
      const month = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_month",
      );
      const year = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_year",
      );
      const prevWeek = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_week",
      );
      const prevMonth = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_month",
      );
      const prevYear = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_year",
      );

      expect(allTime).toBeNull();
      expect(week).toBeNull();
      expect(month).toBeNull();
      expect(year).toBeNull();
      expect(prevWeek).toBeNull();
      expect(prevMonth).toBeNull();
      expect(prevYear).toBeNull();
    });

    it("activities just inside the boundary are included in the current window", async () => {
      await seedContributor(db, "alice");

      // 6 days ago — clearly within the 7-day week window
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 6),
        prAvgTat: 4000000,
      });

      await computeAggregates(makeCtx(db));

      const weekAgg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_week",
      );
      expect(weekAgg).not.toBeNull();
      expect((weekAgg!.value as NumberAggregateValue).value).toBe(4000000);
    });

    it("activities just outside the boundary are excluded from the current window", async () => {
      await seedContributor(db, "alice");

      // 8 days ago — clearly outside the 7-day week window
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 8),
        prAvgTat: 4000000,
      });

      await computeAggregates(makeCtx(db));

      const weekAgg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_week",
      );
      expect(weekAgg).toBeNull();

      // But it should be in the previous_week window (7-14 days ago)
      const prevWeekAgg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time_previous_week",
      );
      expect(prevWeekAgg).not.toBeNull();
      expect((prevWeekAgg!.value as NumberAggregateValue).value).toBe(4000000);
    });

    it("updates global aggregates on re-computation", async () => {
      await seedContributor(db, "alice");

      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#1",
        contributor: "alice",
        occurredAt: subDays(now, 1),
        prAvgTat: 2000000,
      });

      await computeAggregates(makeCtx(db));

      let agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time",
      );
      expect((agg!.value as NumberAggregateValue).value).toBe(2000000);

      // Add another and recompute
      await seedPrMergedActivity(db, {
        slug: "pr_merged_repo#2",
        contributor: "alice",
        occurredAt: subDays(now, 1),
        prAvgTat: 6000000,
      });

      await computeAggregates(makeCtx(db));

      agg = await globalAggregateQueries.getBySlug(
        db,
        "pr_avg_turn_around_time",
      );
      expect((agg!.value as NumberAggregateValue).value).toBe(4000000); // (2M + 6M) / 2
    });

    it("all 7 global slugs are populated with comprehensive data", async () => {
      await seedContributor(db, "alice");

      // Seed activities across all time windows
      const timePoints = [
        subDays(now, 1), // week, month, year, all-time
        subDays(now, 10), // previous_week, month, year, all-time
        subDays(now, 40), // previous_month, year, all-time
        subDays(now, 200), // year, all-time
        subDays(now, 500), // previous_year, all-time
      ];

      for (let i = 0; i < timePoints.length; i++) {
        await seedPrMergedActivity(db, {
          slug: `pr_merged_repo#${i + 1}`,
          contributor: "alice",
          occurredAt: timePoints[i]!,
          prAvgTat: (i + 1) * 1000000,
        });
      }

      await computeAggregates(makeCtx(db));

      const expectedSlugs = [
        "pr_avg_turn_around_time",
        "pr_avg_turn_around_time_week",
        "pr_avg_turn_around_time_month",
        "pr_avg_turn_around_time_year",
        "pr_avg_turn_around_time_previous_week",
        "pr_avg_turn_around_time_previous_month",
        "pr_avg_turn_around_time_previous_year",
      ];

      for (const slug of expectedSlugs) {
        const agg = await globalAggregateQueries.getBySlug(db, slug);
        expect(agg, `Expected ${slug} to exist`).not.toBeNull();
        const value = agg!.value as NumberAggregateValue;
        expect(value.type).toBe("number");
        expect(value.unit).toBe("ms");
        expect(value.format).toBe("duration");
        expect(value.value).toBeGreaterThan(0);
      }
    });
  });
});
