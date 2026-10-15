# Development

## Setup

```sh
git clone https://github.com/syntropic137/syntropic137-setup.git
cd syntropic137-setup
npm install        # Dev deps only: typescript, vitest, @types/node
npm run build      # tsc → dist/
npm test           # vitest
node dist/cli.js --help
```

TypeScript strict mode is required. No `any` types.

## Source structure

```
src/
├── cli.ts          Entry point, arg parsing, 13-step init, subcommands
├── codex.ts        Codex credential: routing (auth.json or OpenAI API key) and the optional init step
├── manifest.ts     GitHub App Manifest flow (ported from Python)
├── server.ts       Local HTTP servers for OAuth callback + form submit
├── docker.ts       Docker Compose lifecycle (check, pull, up, health)
├── secrets.ts      Cryptographic secret generation
├── config.ts       .env template rendering
├── reset.ts        Factory reset: plan (dry run), scope refusals, execute
├── skills.ts       Agent skills install/update/status via the pinned `skills` CLI, legacy plugin migration
├── constants.ts    Shared constants (paths, defaults, command definitions)
├── ui.ts           ANSI colors, spinner, prompts (stdlib only)
└── types.ts        Shared TypeScript types
```

## Template sync

The `templates/` directory contains files vendored from the main [syntropic137/syntropic137](https://github.com/syntropic137/syntropic137) repo. When a new platform version is released:

1. The main repo triggers a `workflow_dispatch` via `gh workflow run` (notification only)
2. The `template-sync.yml` workflow opens a PR with the updated templates
3. A human reviews and merges the PR
4. A human triggers the `publish.yml` workflow to publish to npm

The main repo cannot merge PRs or publish to npm. See [SECURITY.md](../SECURITY.md) for why this matters.

## Related docs

- [Releasing](./releasing.md) — version bumping and npm publish workflow
- [Repository setup](./repository-setup.md) — secrets, branch protection, and upstream dispatch
- [Security](../SECURITY.md) — threat model and design decisions
