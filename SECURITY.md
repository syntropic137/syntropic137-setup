# Security Model

This repository exists as a **separate repo** from the main Syntropic137 platform
(`syntropic137/syntropic137`) specifically for supply chain security. This document
captures the threat model and design decisions so they aren't lost across conversations.

## Why a Separate Repository

The `@syntropic137/setup` npm package is a privileged artifact: users run it with `npx`,
which means arbitrary code execution on their machine. A compromised npm publish is
a supply chain attack on every user.

Keeping the CLI in its own repo provides:

| Isolation | Benefit |
|-----------|---------|
| **Separate npm credentials** | Compromising the main repo's CI does not grant npm publish access |
| **Minimal attack surface** | ~4,600 LOC of TypeScript, stdlib-only, easy to audit per-release |
| **Independent CI/CD** | No shared secrets, tokens, or service accounts with the main repo |
| **Small dependency tree** | Zero runtime dependencies — nothing to typosquat or hijack |

## Template Sync: Pull, Not Push

The CLI embeds template files (`docker-compose.syntropic137.yaml`, `selfhost-entrypoint.sh`,
`selfhost.env.example`, `init-db/*.sql`) that originate in the main repo.

### How templates are updated

1. The main repo triggers a `workflow_dispatch` via `gh workflow run` on release (notification only)
2. A workflow **in this repo** pulls the latest templates from the main repo's tagged release
3. It opens a **pull request** — a human must review and merge
4. npm publish is a **separate manual step** (requires `workflow_dispatch` approval)

### What this prevents

- **Main repo compromise ≠ npm compromise** — the dispatch token can trigger workflow
  runs but cannot push code (`contents:write` is not granted). Template sync PRs are
  created by the workflow's `GITHUB_TOKEN`, not the dispatch token.
- **Publish only deploys reviewed code** — even if the dispatch token triggers
  `publish.yml`, it publishes whatever is on `main`. Since the token cannot push to
  any branch, it cannot get malicious code into the publish pipeline. The real attack
  vector is social engineering (tricking a maintainer into merging a malicious
  template-sync PR), not token exploitation.
- **No auto-publish** — even if a malicious PR is opened via dispatch, it requires
  human review before merge, and a separate `workflow_dispatch` before npm publish.
- **No runtime fetching** — the CLI never downloads templates at runtime. What ships
  in the npm package is what users get. The package is a static, auditable snapshot.

## npm Publish Security

- Publishing requires **manual `workflow_dispatch`** trigger with approval
- The publish workflow runs `tsc --noEmit` (strict mode) and tests before publishing
- **Trusted Publishing (OIDC)** — no npm token stored in GitHub secrets. The npm
  registry verifies the publish request came from this specific repo, workflow, and
  environment via GitHub's OIDC identity provider. There is no long-lived credential
  to steal or rotate.
- **Provenance attestation** — every published version includes a signed provenance
  statement linking the package back to the exact commit and workflow run that built
  it. Users can verify this with `npm audit signatures`.

## Code Security

- **Zero runtime dependencies** — Node 20.12+ stdlib only (`node:http`, `node:https`,
  `node:crypto`, `node:fs`, `node:child_process`, `node:readline`)
- **TypeScript strict mode** — `"strict": true` in tsconfig, no `any` types
- **Secret files live in a 0700 directory** - the `secrets/` directory is owner-only (0700), so no other host user can reach them. The files compose mounts into containers (generated passwords, GitHub App PEM) are 0644 inside it, because the containers read them as non-root users (#78); backups (`*.bak`) and non-mounted GitHub secrets stay 0600
- **CSRF protection** — the GitHub App Manifest flow uses a random state parameter
  validated on callback
- **No shell injection:** every subprocess (Docker, npm, npx, claude) runs through
  `execFileSync` or `execFile` with an argument array (never `exec` or a shell with
  string interpolation), preventing argument injection
- **Agent skills via a pinned CLI:** the optional skills step runs an exact
  `skills@<version>` through npx (see `SKILLS_CLI_VERSION` in `src/constants.ts`),
  never a floating tag. The skills themselves come from
  `syntropic137/syntropic137-skills` and are installed only after the user agrees
  (interactive init) or asks for them (`skills` command)

## Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| Main repo CI compromise | No npm credentials in main repo; dispatch token can trigger workflows but cannot push code — publish only deploys what's on `main` |
| Dispatch token leak | Token can trigger workflow runs but cannot push code; publish deploys existing `main` content; wait timer gives time to cancel |
| This repo CI compromise | npm publish requires manual `workflow_dispatch`, not auto-triggered |
| npm credential theft | No stored credentials — Trusted Publishing uses ephemeral OIDC tokens |
| Dependency hijack | Zero runtime dependencies |
| Template tampering via PR | Human review required on all PRs |
| Malicious template injection | Templates are vendored snapshots, not fetched at runtime |
| Secret leakage in .env | Service passwords and the GitHub App key are separate files in a 0700 directory; the gateway password, Anthropic credential, webhook secret and tunnel token are in .env, which is 0600 and excluded from git via .gitignore |
| CLI argument injection | `execFile` / `execFileSync` / `spawn` with argument arrays for all subprocess calls (the Windows browser opener goes through `cmd.exe /c start`) |
