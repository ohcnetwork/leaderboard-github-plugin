import {
  contributorAggregateQueries,
  globalAggregateQueries,
  type Database,
  type PluginContext,
} from "@ohcnetwork/leaderboard-api";
import { subDays } from "date-fns";
import { ActivityDefinition } from "./activity";

export async function computeAggregates(ctx: PluginContext) {
  ctx.logger.info("Computing aggregates...");

  await computePrAvgTurnAroundTime(ctx);
  await computeGlobalPrAvgTurnAroundTime(ctx);

  ctx.logger.info("Aggregates computed");
}

async function queryContributorAvgTat(db: Database) {
  return db.execute(
    `SELECT contributor, AVG(json_extract(meta, '$.pr_avg_tat')) as avg_tat, COUNT(*) as pr_count
     FROM activity
     WHERE activity_definition = ?
       AND json_extract(meta, '$.pr_avg_tat') IS NOT NULL
     GROUP BY contributor`,
    [ActivityDefinition.PR_MERGED],
  );
}

async function queryGlobalAvgTat(db: Database, since: string | null) {
  const sql = since
    ? `SELECT AVG(json_extract(meta, '$.pr_avg_tat')) as avg_tat, COUNT(*) as pr_count
       FROM activity
       WHERE activity_definition = ?
         AND json_extract(meta, '$.pr_avg_tat') IS NOT NULL
         AND occurred_at >= ?`
    : `SELECT AVG(json_extract(meta, '$.pr_avg_tat')) as avg_tat, COUNT(*) as pr_count
       FROM activity
       WHERE activity_definition = ?
         AND json_extract(meta, '$.pr_avg_tat') IS NOT NULL`;

  const params: unknown[] = [ActivityDefinition.PR_MERGED];
  if (since) params.push(since);

  return db.execute(sql, params);
}

async function computePrAvgTurnAroundTime({ db, logger }: PluginContext) {
  const result = await queryContributorAvgTat(db);

  for (const row of result.rows) {
    const contributor = row.contributor as string;
    const avgTat = row.avg_tat as number;
    const prCount = row.pr_count as number;

    await contributorAggregateQueries.upsert(db, {
      aggregate: "pr_avg_turn_around_time",
      contributor,
      value: {
        type: "number",
        value: avgTat,
        unit: "ms",
        format: "duration",
      },
      meta: {
        source: "github_api",
        calculated_at: new Date().toISOString(),
        pr_count: prCount,
      },
    });
  }

  logger.info(
    `Computed pr_avg_turn_around_time for ${result.rows.length} contributors`,
  );
}

async function computeGlobalPrAvgTurnAroundTime({ db, logger }: PluginContext) {
  const now = new Date();
  const windows = [
    {
      slug: "pr_avg_turn_around_time",
      name: "Avg PR Turn Around Time",
      days: null,
    },
    {
      slug: "pr_avg_turn_around_time_7d",
      name: "Avg PR Turn Around Time (7d)",
      days: 7,
    },
    {
      slug: "pr_avg_turn_around_time_30d",
      name: "Avg PR Turn Around Time (30d)",
      days: 30,
    },
    {
      slug: "pr_avg_turn_around_time_365d",
      name: "Avg PR Turn Around Time (1y)",
      days: 365,
    },
  ] as const;

  for (const window of windows) {
    const since = window.days ? subDays(now, window.days).toISOString() : null;

    const result = await queryGlobalAvgTat(db, since);
    const row = result.rows[0];
    if (!row?.avg_tat) continue;

    const avgTat = row.avg_tat as number;
    const prCount = row.pr_count as number;

    await globalAggregateQueries.upsert(db, {
      slug: window.slug,
      name: window.name,
      description: `Average time taken for PRs to get merged${window.days ? ` (last ${window.days} days)` : ""}`,
      value: {
        type: "number",
        value: avgTat,
        unit: "ms",
        format: "duration",
      },
      meta: {
        source: "github_api",
        calculated_at: now.toISOString(),
        pr_count: prCount,
      },
    });

    logger.info(`Computed global ${window.slug} from ${prCount} PRs`);
  }
}
