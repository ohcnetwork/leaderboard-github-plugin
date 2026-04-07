# @ohcnetwork/leaderboard-github-plugin

Leaderboard github plugin

## Configuration

Add the plugin to your `config.yaml`:

```yaml
leaderboard:
  plugins:
    github:
      source: "@ohcnetwork/leaderboard-github-plugin"
      config:
        githubOrg: ${{ env.GITHUB_ORG }}
        # Single token (basic):
        githubToken: ${{ env.GITHUB_TOKEN }}
        # Multiple tokens (recommended for large orgs to avoid rate limits):
        # githubTokens:
        #   - ${{ env.GITHUB_TOKEN_1 }}
        #   - ${{ env.GITHUB_TOKEN_2 }}
        #   - ${{ env.GITHUB_TOKEN_3 }}
        # Optional: Blacklist contributors (exclude from tracking):
        # blacklist:
        #   - invalid-email-address
        #   - bot-account
```

### Config Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `githubOrg` | `string` | Yes | GitHub organization name |
| `githubToken` | `string` | Yes* | A single GitHub personal access token |
| `githubTokens` | `string[]` | Yes* | Array of GitHub tokens for rotation on rate limit |
| `blacklist` | `string[]` | No | Array of GitHub usernames to exclude from tracking |

\* At least one of `githubToken` or `githubTokens` must be provided. When multiple tokens are supplied, the plugin automatically rotates to the next available token when one hits GitHub's rate limit, instead of waiting an hour.

### Checkpoint & Recovery

The plugin saves progress after each repository is scraped. If the process fails mid-way:

- **Automatic resume**: Rerun the scrape and already-completed repos are skipped.
- **Progress tracking**: Check `scrape-status.md` in your data directory for a live status table.
- **Reset**: Delete `.scrape-progress.json` from your data directory to force a full rescrape.

## Usage

1. Build the plugin:

```bash
pnpm build
```

2. Add the plugin to your `config.yaml` (see Configuration above)

3. Run the plugin runner:

```bash
pnpm data:scrape
```

## Development

```bash
# Build the plugin
pnpm build

# Run tests
pnpm test

# Watch mode
pnpm test:watch
```

## Release Process

This package uses [changesets](https://github.com/changesets/changesets) for version management and automated publishing to GitHub's npm registry.

### For Contributors

When making changes that should be included in the next release:

1. Make your code changes
2. Run `pnpm changeset` to create a changeset file
3. Select the type of change (major, minor, or patch)
4. Describe your changes in the prompt
5. Commit the generated changeset file along with your changes

```bash
pnpm changeset
git add .changeset/
git commit -m "feat: your feature description"
```

### For Maintainers

The release process is automated via GitHub Actions:

1. When PRs with changesets are merged to `main`, a "Version Packages" PR is automatically created/updated
2. Review the Version Packages PR to verify:
   - Version bumps are correct
   - CHANGELOG entries are accurate
3. Merge the Version Packages PR to automatically publish to GitHub's npm registry

### Manual Publishing (if needed)

If you need to publish manually:

```bash
pnpm build
pnpm release
```

Note: You'll need to be authenticated with GitHub's npm registry and have the appropriate permissions.

### Installing from GitHub Packages

To install this package from GitHub's npm registry:

1. Create or update your `.npmrc` file:

```
@ohcnetwork/leaderboard-github-plugin:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

2. Install the package:

```bash
npm install @ohcnetwork/leaderboard-github-plugin
```


## License

MIT
