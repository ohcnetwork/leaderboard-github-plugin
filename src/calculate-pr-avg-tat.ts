import {
  contributorAggregateQueries,
  activityQueries,
  Database,
  Logger,
} from "@ohcnetwork/leaderboard-api";
import { ActivityDefinition } from "./activity";
import { formatDuration, intervalToDuration } from "date-fns";

export async function calculatePrAvgTat(db: Database, logger: Logger) {
  const allActivities = await activityQueries.getAll(db);
  const activities = allActivities.filter(activity => activity.activity_definition === ActivityDefinition.PR_MERGED);

  const contributorPRs = new Map<string, typeof activities>();
  for (const activity of activities) {
    if (!activity.contributor) continue;

    const prs = contributorPRs.get(activity.contributor) || [];
    prs.push(activity);
    contributorPRs.set(activity.contributor, prs);
  }

  for (const [username, prs] of contributorPRs) {
    let totalTat = 0;
    let prCount = 0;

    for (const pr of prs) {
      const meta = pr.meta as any;
      if (meta?.created_at && meta?.merged_at) {
        totalTat += new Date(meta.merged_at).getTime() - new Date(meta.created_at).getTime();
        prCount++;
      }
    }

    if (prCount === 0) continue;

    const avgTat = totalTat / prCount;
    const avgTatHours = avgTat / (1000 * 60 * 60);

    const duration = intervalToDuration({ start: 0, end: avgTat });
    const formattedDuration = formatDuration(duration, { format: ['months', 'weeks', 'days', 'hours'] });

    await contributorAggregateQueries.upsert(db, {
      aggregate: "avg_tat",
      contributor: username,
      value: {
        type: "string",
        value: formattedDuration,
      },
      meta: {
        calculated_at: new Date().toISOString(),
        pr_count: prCount,
      },
    });
  }

  logger.info(`Calculated PR avg TAT for ${contributorPRs.size} contributors`);
}