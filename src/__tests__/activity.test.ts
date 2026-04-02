import { describe, it, expect } from "vitest";
import {
  ActivityDefinition,
  type ActivityDefinitionConfig,
  getDisabledSlugs,
  resolveActivityDefinitions,
} from "../activity";

const DEFAULTS = [
  {
    slug: ActivityDefinition.PR_OPENED,
    name: "PR Opened",
    description: "Opened a Pull Request",
    points: 1 as number | null,
    icon: "git-pull-request-create-arrow" as string | null,
  },
  {
    slug: ActivityDefinition.PR_MERGED,
    name: "PR Merged",
    description: "Merged a Pull Request",
    points: 5 as number | null,
    icon: "git-merge" as string | null,
  },
  {
    slug: ActivityDefinition.COMMITED,
    name: "Commit Created",
    description: "Pushed a commit",
    points: null as number | null,
    icon: "git-commit-horizontal" as string | null,
  },
];

describe("getDisabledSlugs", () => {
  it("returns empty set when no config is provided", () => {
    expect(getDisabledSlugs(undefined)).toEqual(new Set());
  });

  it("returns empty set when config has no disabled entries", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { points: 10 },
    };
    expect(getDisabledSlugs(config)).toEqual(new Set());
  });

  it("returns slugs where disabled is true", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { disabled: true },
      [ActivityDefinition.PR_MERGED]: { points: 10 },
      [ActivityDefinition.COMMENTED]: { disabled: true },
    };
    const result = getDisabledSlugs(config);
    expect(result).toEqual(
      new Set([ActivityDefinition.PR_OPENED, ActivityDefinition.COMMENTED]),
    );
  });

  it("does not treat disabled: false as disabled", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { disabled: false, points: 3 },
    };
    expect(getDisabledSlugs(config)).toEqual(new Set());
  });
});

describe("resolveActivityDefinitions", () => {
  it("returns defaults unchanged when no config is provided", () => {
    const { definitions, disabledSlugs } = resolveActivityDefinitions(DEFAULTS);
    expect(definitions).toEqual(DEFAULTS);
    expect(disabledSlugs.size).toBe(0);
  });

  it("returns defaults unchanged when config is undefined", () => {
    const { definitions } = resolveActivityDefinitions(DEFAULTS, undefined);
    expect(definitions).toEqual(DEFAULTS);
  });

  it("returns defaults unchanged for empty config object", () => {
    const { definitions } = resolveActivityDefinitions(DEFAULTS, {});
    expect(definitions).toEqual(DEFAULTS);
  });

  it("overrides points when specified in config", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { points: 10 },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prOpened = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_OPENED,
    );
    expect(prOpened?.points).toBe(10);
  });

  it("overrides icon when specified in config", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { icon: "custom-icon" },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prOpened = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_OPENED,
    );
    expect(prOpened?.icon).toBe("custom-icon");
  });

  it("allows overriding points to null", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_MERGED]: { points: null },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prMerged = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_MERGED,
    );
    expect(prMerged?.points).toBeNull();
  });

  it("allows overriding icon to null", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { icon: null },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prOpened = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_OPENED,
    );
    expect(prOpened?.icon).toBeNull();
  });

  it("preserves default points when not specified in override", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_MERGED]: { icon: "new-icon" },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prMerged = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_MERGED,
    );
    expect(prMerged?.points).toBe(5);
  });

  it("preserves default icon when not specified in override", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_MERGED]: { points: 20 },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prMerged = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_MERGED,
    );
    expect(prMerged?.icon).toBe("git-merge");
  });

  it("excludes disabled definitions from output", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { disabled: true },
    };
    const { definitions, disabledSlugs } = resolveActivityDefinitions(
      DEFAULTS,
      config,
    );
    expect(definitions.find((d) => d.slug === ActivityDefinition.PR_OPENED)).toBeUndefined();
    expect(definitions).toHaveLength(DEFAULTS.length - 1);
    expect(disabledSlugs.has(ActivityDefinition.PR_OPENED)).toBe(true);
  });

  it("can disable multiple definitions at once", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { disabled: true },
      [ActivityDefinition.PR_MERGED]: { disabled: true },
    };
    const { definitions, disabledSlugs } = resolveActivityDefinitions(
      DEFAULTS,
      config,
    );
    expect(definitions).toHaveLength(1);
    expect(definitions[0]!.slug).toBe(ActivityDefinition.COMMITED);
    expect(disabledSlugs.size).toBe(2);
  });

  it("does not modify name or description from defaults", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { points: 99, icon: "rocket" },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prOpened = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_OPENED,
    );
    expect(prOpened?.name).toBe("PR Opened");
    expect(prOpened?.description).toBe("Opened a Pull Request");
  });

  it("leaves definitions without overrides untouched", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { points: 10 },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);
    const prMerged = definitions.find(
      (d) => d.slug === ActivityDefinition.PR_MERGED,
    );
    expect(prMerged).toEqual(DEFAULTS[1]);
  });

  it("applies overrides to multiple definitions independently", () => {
    const config: ActivityDefinitionConfig = {
      [ActivityDefinition.PR_OPENED]: { points: 10 },
      [ActivityDefinition.PR_MERGED]: { icon: "check" },
      [ActivityDefinition.COMMITED]: { points: 1 },
    };
    const { definitions } = resolveActivityDefinitions(DEFAULTS, config);

    expect(
      definitions.find((d) => d.slug === ActivityDefinition.PR_OPENED)?.points,
    ).toBe(10);
    expect(
      definitions.find((d) => d.slug === ActivityDefinition.PR_MERGED)?.icon,
    ).toBe("check");
    expect(
      definitions.find((d) => d.slug === ActivityDefinition.COMMITED)?.points,
    ).toBe(1);
  });
});
