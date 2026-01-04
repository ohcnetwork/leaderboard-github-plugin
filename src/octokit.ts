import { Octokit } from "octokit";
import { PluginConfig } from "@leaderboard/api";

let cachedOctokit: Octokit | null = null;
export const getOctokit = (config: PluginConfig): Octokit => {
  const githubOrg = config.githubOrg;
  const githubToken = config.githubToken;
  if (!githubOrg) {
    throw new Error("'githubOrg' is not set in the plugin config");
  }
  if (!githubToken) {
    throw new Error("'githubToken' is not set in the plugin config");
  }

  if (cachedOctokit) return cachedOctokit;
  const octokit = new Octokit({
    auth: githubToken,
  });
  cachedOctokit = octokit;
  return octokit;
};
