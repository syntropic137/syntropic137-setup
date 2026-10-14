# syntropic137-setup

> **Releasing?** Read [docs/releasing.md](./docs/releasing.md) first: versioning scheme, template sync, publishing workflow, and CI checks.

Zero-dependency CLI (`@syntropic137/setup`) for one-command Syntropic137 self-host deployment. This repo does NOT contain the platform, only the setup CLI. Templates are vendored from the main repo.

## Security invariants

**Read [SECURITY.md](./SECURITY.md) before changing CI, publishing, or template sync.**

- **Zero runtime dependencies:** stdlib only, never add `dependencies` to package.json
- **No auto-publish:** npm publish always requires manual human approval
- **Templates are vendored:** embedded in the package, never fetched at runtime
- **No shared credentials:** this repo has no access to the main repo's secrets, and vice versa
- **`execFile` / `execFileSync` only:** always pass an argument array, never use `exec` or a shell with string interpolation for subprocess calls

## Markdown style

Never use dashes as inline punctuation within sentences or as label separators. This means no hyphen-as-dash (` - `), no en dashes, and no em dashes. Use colons, commas, or natural word structure instead. Note: standard list bullet markers (`-`) are fine.

- **Labels and descriptions:** use a colon. Example: `**Step name:** description of what it does`
- **Sentence continuations:** use a comma or reword with "so", "and", "then", or "because"
- **Parenthetical asides:** use parentheses or rewrite as a separate clause

This applies to all `.md` files in this repo, including README, AGENTS, docs/, and any generated output.

## Build

```sh
npm install     # dev deps only (typescript, vitest, @types/node)
npm run build   # tsc -> dist/
npm test        # vitest
```

TypeScript strict mode is required. No `any` types. See tsconfig.json.

## Docs

- [docs/releasing.md](./docs/releasing.md): versioning, template sync, npm publish, CI checks
- [docs/development.md](./docs/development.md): setup, source structure, dev workflow
- [docs/repository-setup.md](./docs/repository-setup.md): secrets, branch protection, upstream dispatch
- [SECURITY.md](./SECURITY.md): threat model, supply chain design decisions
