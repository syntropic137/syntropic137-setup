import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".syntropic137");
export const COMPOSE_FILE = "docker-compose.syntropic137.yaml";
/** The `name:` the selfhost compose file declares. Reset touches no other project. */
export const SELFHOST_COMPOSE_PROJECT = "syntropic137_selfhost";
/** Registry prefix of every Syntropic137 image (`reset --images`). */
export const SYNTROPIC137_IMAGE_PREFIX = "ghcr.io/syntropic137/";
/** npm package of the `syn` CLI. */
export const SYN_CLI_PACKAGE = "@syntropic137/cli";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_APP_NAME = "syntropic137";
export const DEFAULT_PORT = "8137";
export const DEFAULT_APP_ENVIRONMENT = "selfhost";
export const DEFAULT_API_USER = "admin";

// ---------------------------------------------------------------------------
// Environment variable keys (single source of truth — no magic strings)
// ---------------------------------------------------------------------------

export const ENV_KEYS = {
  SYN_API_PASSWORD: "SYN_API_PASSWORD",
  SYN_API_USER: "SYN_API_USER",
  SYN_GATEWAY_PORT: "SYN_GATEWAY_PORT",
  SYN_VERSION: "SYN_VERSION",
  SYN_INSTALL_DIR: "SYN_INSTALL_DIR",
  APP_ENVIRONMENT: "APP_ENVIRONMENT",
  ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
  CLAUDE_CODE_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN",
  SYN_GITHUB_APP_ID: "SYN_GITHUB_APP_ID",
  SYN_GITHUB_APP_NAME: "SYN_GITHUB_APP_NAME",
  SYN_GITHUB_APP_ORG: "SYN_GITHUB_APP_ORG",
  SYN_GITHUB_WEBHOOK_SECRET: "SYN_GITHUB_WEBHOOK_SECRET",
  COMPOSE_PROFILES: "COMPOSE_PROFILES",
  CLOUDFLARE_TUNNEL_TOKEN: "CLOUDFLARE_TUNNEL_TOKEN",
  SYN_PUBLIC_HOSTNAME: "SYN_PUBLIC_HOSTNAME",
  MINIO_ROOT_USER: "MINIO_ROOT_USER",
} as const;

// ---------------------------------------------------------------------------
// CLI command reference (single source of truth for all user-facing commands)
// ---------------------------------------------------------------------------

/**
 * Public path of the GitHub webhook receiver behind the gateway: the nginx
 * `location = /api/v1/webhooks/github` in the platform's gateway entrypoint,
 * proxied to the API's `/webhooks/github`. 1.0.1 printed
 * `/api/v1/github/webhooks`, which the gateway does not serve.
 */
export const GITHUB_WEBHOOK_PATH = "/api/v1/webhooks/github";

export const BIN = "npx @syntropic137/setup";

export interface CommandDef {
  name: string;
  description: string;
  /** Shown in help text after the command, e.g. "[options]" */
  args?: string;
}

/**
 * All available CLI commands. The menu, help text, and summary box
 * all derive from this single list.
 */
export const COMMANDS: readonly CommandDef[] = [
  { name: "init",        description: "Bootstrap a Syntropic137 stack", args: "[options]" },
  { name: "status",      description: "Show container health" },
  { name: "start",       description: "Start the stack" },
  { name: "stop",        description: "Stop the stack" },
  { name: "logs",        description: "Tail container logs" },
  { name: "update",      description: "Pull latest images and restart" },
  { name: "cli",         description: "Install or update the Syntropic137 CLI" },
  { name: "skills",      description: "Install, update, or check the agent skills", args: "[install|update|status]" },
  { name: "github-app",  description: "Open GitHub App settings in your browser" },
  { name: "tunnel",      description: "Set up remote access (Cloudflare tunnel)" },
  { name: "credentials", description: "View, rotate, or roll back service credentials", args: "[show|rotate|rollback]" },
  { name: "reset",       description: "Factory reset: remove the install (dry run unless --yes)", args: "[options]" },
] as const;

/** Shorthand lookup: CMD.init → "npx @syntropic137/setup init" */
export const CMD = Object.fromEntries([
  ...COMMANDS.map((c) => [c.name, `${BIN} ${c.name}`]),
  ["skipDocker", `${BIN} init --skip-docker`],
]) as Record<string, string>;

// ---------------------------------------------------------------------------
// Template files to copy during init
// ---------------------------------------------------------------------------

export const TEMPLATE_FILES = [
  "docker-compose.syntropic137.yaml",
  "selfhost-entrypoint.sh",
  "selfhost.env.example",
  "init-db/01-create-databases.sql",
] as const;

// ---------------------------------------------------------------------------
// Secret file names
// ---------------------------------------------------------------------------

export const SECRET_FILES = [
  "db-password.secret",
  "redis-password.secret",
  "minio-password.secret",
] as const;

export const PEM_FILE = "github-app-private-key.pem";
export const WEBHOOK_SECRET_FILE = "github-webhook-secret.txt";
export const CLIENT_SECRET_FILE = "github-client-secret.txt";

// ---------------------------------------------------------------------------
// Agent skills (installed with the `skills` CLI for Claude Code and Codex)
// ---------------------------------------------------------------------------

/** Exact `skills` CLI release we run through npx. Bump on purpose, never float. */
export const SKILLS_CLI_VERSION = "1.7.0";
export const SKILLS_CLI_PACKAGE = `skills@${SKILLS_CLI_VERSION}`;
/**
 * Oldest Node the pinned skills CLI runs on. It declares >=22.20 but runs on
 * 20.x; Node 18 fails at import (`node:util` has no `styleText` before 20.12).
 */
export const SKILLS_CLI_MIN_NODE: readonly [number, number] = [20, 12];
/** GitHub source of the Syntropic137 agent skills. */
export const SKILLS_REPO = "syntropic137/syntropic137-skills";

export interface SkillsAgent {
  /** Agent id understood by `skills add -a <id>`. */
  readonly id: string;
  /** Binary we probe on PATH to decide whether the agent is installed. */
  readonly bin: string;
  /** Human-readable name. */
  readonly label: string;
}

export const SKILLS_AGENTS: readonly SkillsAgent[] = [
  { id: "claude-code", bin: "claude", label: "Claude Code" },
  { id: "codex", bin: "codex", label: "Codex" },
] as const;

// ---------------------------------------------------------------------------
// Legacy Claude Code plugin (replaced by the agent skills above)
// ---------------------------------------------------------------------------

/** Marketplace name the old setup registered with `claude plugin marketplace add`. */
export const LEGACY_PLUGIN_MARKETPLACE = "syntropic137";
/** Repo the old marketplace pointed at. */
export const LEGACY_PLUGIN_REPO = "syntropic137/syntropic137-claude-plugin";
/** Full plugin id (`name@marketplace`) the old setup installed. */
export const LEGACY_PLUGIN_ID = "syntropic137@syntropic137";

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export const GITHUB_BASE = "https://github.com";
export const GITHUB_SLUG_RE = /^[a-zA-Z0-9-]+$/;
export const GITHUB_API = "https://api.github.com";
export const PROJECT_URL = "https://github.com/syntropic137/syntropic137";

// ---------------------------------------------------------------------------
// Docker health check
// ---------------------------------------------------------------------------

export const MIN_COMPOSE_VERSION: [number, number] = [2, 20];
export const HEALTH_CHECK_TIMEOUT_MS = 120_000;
export const HEALTH_CHECK_INTERVAL_MS = 2_000;
export const MANIFEST_TIMEOUT_MS = 300_000;
