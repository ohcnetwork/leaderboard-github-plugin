import { contributorQueries, Database, Logger } from "@leaderboard/api";

export async function addNewContributors(db: Database, contributors: string[]) {
  // Remove duplicates from the array
  contributors = [...new Set(contributors)];

  for (const contributor of contributors) {
    await contributorQueries.insertOrIgnore(db, {
      username: contributor,
      name: null,
      role: null,
      title: null,
      bio: null,
      joining_date: null,
      avatar_url: `https://avatars.githubusercontent.com/${contributor}`,
      social_profiles: {
        github: `https://github.com/${contributor}`,
      },
      meta: {},
    });
  }
}

/**
 * Update the role of bot contributors to 'bot'
 * @param botUsernames - Array of bot usernames to update
 */
export async function updateBotRoles(
  db: Database,
  botUsernames: string[],
  logger: Logger
) {
  if (botUsernames.length === 0) {
    logger.info("No bot users to update");
    return;
  }

  // Remove duplicates
  const uniqueBotUsernames = [...new Set(botUsernames)];

  for (const username of uniqueBotUsernames) {
    const result = await db.execute(
      `
        UPDATE contributor
        SET role = 'bot'
        WHERE username = ?;
      `,
      [username]
    );

    logger.info(`Updated ${result.rowsAffected} bot contributors`);
  }
}
