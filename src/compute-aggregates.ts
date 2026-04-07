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

async function queryGlobalAvgTat(
  db: Database,
  since: string | null,
  until: string | null,
) {
  let sql = `SELECT AVG(json_extract(meta, '$.pr_avg_tat')) as avg_tat, COUNT(*) as pr_count
       FROM activity
       WHERE activity_definition = ?
         AND json_extract(meta, '$.pr_avg_tat') IS NOT NULL`;

  const params: unknown[] = [ActivityDefinition.PR_MERGED];

  if (since) {
    sql += ` AND occurred_at >= ?`;
    params.push(since);
  }
  if (until) {
    sql += ` AND occurred_at < ?`;
    params.push(until);
  }

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
      since: null,
      until: null,
    },
    {
      slug: "pr_avg_turn_around_time_week",
      name: "Avg PR Turn Around Time (Week)",
      since: subDays(now, 7),
      until: null,
    },
    {
      slug: "pr_avg_turn_around_time_month",
      name: "Avg PR Turn Around Time (Month)",
      since: subDays(now, 30),
      until: null,
    },
    {
      slug: "pr_avg_turn_around_time_year",
      name: "Avg PR Turn Around Time (Year)",
      since: subDays(now, 365),
      until: null,
    },
    {
      slug: "pr_avg_turn_around_time_previous_week",
      name: "Avg PR Turn Around Time (Previous Week)",
      since: subDays(now, 14),
      until: subDays(now, 7),
    },
    {
      slug: "pr_avg_turn_around_time_previous_month",
      name: "Avg PR Turn Around Time (Previous Month)",
      since: subDays(now, 60),
      until: subDays(now, 30),
    },
    {
      slug: "pr_avg_turn_around_time_previous_year",
      name: "Avg PR Turn Around Time (Previous Year)",
      since: subDays(now, 730),
      until: subDays(now, 365),
    },
  ];

  for (const window of windows) {
    const sinceStr = window.since?.toISOString() ?? null;
    const untilStr = window.until?.toISOString() ?? null;

    const result = await queryGlobalAvgTat(db, sinceStr, untilStr);
    const row = result.rows[0];
    if (!row?.avg_tat) continue;

    const avgTat = row.avg_tat as number;
    const prCount = row.pr_count as number;

    await globalAggregateQueries.upsert(db, {
      slug: window.slug,
      name: window.name,
      description: null,
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
