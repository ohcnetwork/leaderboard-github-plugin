export enum ActivityDefinition {
  ISSUE_OPENED = "issue_opened",
  ISSUE_CLOSED = "issue_closed",
  PR_OPENED = "pr_opened",
  PR_CLOSED = "pr_closed",
  PR_MERGED = "pr_merged",
  PR_REVIEWED = "pr_reviewed",
  PR_COLLABORATED = "pr_collaborated",
  ISSUE_ASSIGNED = "issue_assigned",
  COMMENTED = "commented",
  COMMITED = "commited",
}

export interface ActivityDefinitionOverride {
  disabled?: boolean;
  points?: number | null;
  icon?: string | null;
}

export interface CommitActivityDefinitionOverride extends ActivityDefinitionOverride {
  pointsOnDefaultBranch?: number;
  pointsOnNonDefaultBranch?: number;
}

export type ActivityDefinitionConfig = {
  [K in ActivityDefinition]?: K extends ActivityDefinition.COMMITED
    ? CommitActivityDefinitionOverride
    : ActivityDefinitionOverride;
};

interface DefaultActivityDefinition {
  slug: ActivityDefinition;
  name: string;
  description: string;
  points: number | null;
  icon: string | null;
}

export function getDisabledSlugs(
  configOverrides?: ActivityDefinitionConfig,
): Set<string> {
  const disabled = new Set<string>();
  if (!configOverrides) return disabled;

  for (const [slug, override] of Object.entries(configOverrides)) {
    if (override?.disabled) {
      disabled.add(slug);
    }
  }
  return disabled;
}

export function resolveActivityDefinitions(
  defaults: DefaultActivityDefinition[],
  configOverrides?: ActivityDefinitionConfig,
): {
  definitions: DefaultActivityDefinition[];
  disabledSlugs: Set<string>;
} {
  const disabledSlugs = getDisabledSlugs(configOverrides);

  if (!configOverrides) {
    return { definitions: defaults, disabledSlugs };
  }

  const definitions: DefaultActivityDefinition[] = [];

  for (const def of defaults) {
    if (disabledSlugs.has(def.slug)) {
      continue;
    }

    const override = configOverrides[def.slug];
    if (!override) {
      definitions.push(def);
      continue;
    }

    definitions.push({
      ...def,
      points: override.points !== undefined ? override.points : def.points,
      icon: override.icon !== undefined ? override.icon : def.icon,
    });
  }

  return { definitions, disabledSlugs };
}
