import * as fs from "node:fs";
import * as path from "node:path";
import { CMD, COMPOSE_FILE, ENV_KEYS } from "./constants.js";

// ---------------------------------------------------------------------------
// Codex credential: routing and the optional init step (#92)
// ---------------------------------------------------------------------------
//
// A codex phase authenticates with one of two credentials:
//
//   CODEX_AUTH_JSON  the full contents of a Codex `auth.json` (a Codex or
//                    ChatGPT plan login, or an API-key mode login)
//   OPENAI_API_KEY   a pay-as-you-go OpenAI API key (needs the platform
//                    release with syntropic137/syntropic137#1971)
//
// The platform prefers CODEX_AUTH_JSON when both are set, so setup writes
// exactly one, the one the user chose.

/** Which credential a codex phase will use. */
export type CodexCredentialKind = "auth-json" | "api-key";

/** A credential routed to the env var the platform reads it from. */
export interface CodexCredential {
  envKey: typeof ENV_KEYS.CODEX_AUTH_JSON | typeof ENV_KEYS.OPENAI_API_KEY;
  /** Single-line value, ready for `.env`. Never print it. */
  value: string;
  kind: CodexCredentialKind;
  /**
   * The refresh token inside a plan login, used only to detect that this is
   * the same login as this machine's (#893). Null for API keys.
   */
  refreshToken: string | null;
}

export type CodexRoute =
  | ({ ok: true } & CodexCredential)
  | { ok: false; reason: string };

/** Human label for a credential kind (summary, messages). */
export function codexKindLabel(kind: CodexCredentialKind): string {
  return kind === "auth-json" ? "Codex auth.json" : "OpenAI API key";
}

const API_KEY_RE = /^sk-[A-Za-z0-9_-]{16,}$/;

/** Route a value that should be an OpenAI API key. */
export function routeOpenAIApiKey(raw: string): CodexRoute {
  const value = stripQuotes(raw);
  if (value.startsWith("sk-ant-")) {
    return { ok: false, reason: "That is an Anthropic key (sk-ant-...), not an OpenAI API key." };
  }
  if (!API_KEY_RE.test(value)) {
    return { ok: false, reason: "Does not look like an OpenAI API key (expected sk-... with no spaces)." };
  }
  return { ok: true, envKey: ENV_KEYS.OPENAI_API_KEY, value, kind: "api-key", refreshToken: null };
}

/**
 * Validate the text of a Codex auth.json and return it as one line.
 *
 * Checks it is a JSON object with a string `auth_mode`, which every
 * auth.json `codex login` writes (`apikey`, or the ChatGPT plan modes).
 */
export function routeCodexAuthJson(text: string): CodexRoute {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Not valid JSON." };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "Not a JSON object." };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.auth_mode !== "string" || obj.auth_mode === "") {
    return { ok: false, reason: "Not a Codex auth.json (no auth_mode field)." };
  }
  // One line, no whitespace: .env is line based, and an unquoted compose
  // .env value loses everything after a space-prefixed `#`.
  const value = JSON.stringify(obj);
  // Compose interpolates `$` in .env values, which would silently change the
  // credential. Codex tokens never contain one; refuse rather than corrupt.
  if (value.includes("$")) {
    return { ok: false, reason: "Contains a `$`, which Docker Compose would rewrite in .env. Add it to .env by hand, escaped as `$$`." };
  }
  const tokens = obj.tokens;
  let refreshToken: string | null = null;
  if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
    const rt = (tokens as Record<string, unknown>).refresh_token;
    if (typeof rt === "string" && rt !== "") refreshToken = rt;
  }
  return { ok: true, envKey: ENV_KEYS.CODEX_AUTH_JSON, value, kind: "auth-json", refreshToken };
}

/** Expand a leading `~` the way a shell would. */
export function expandHome(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/")) return path.join(homedir, p.slice(2));
  return p;
}

/**
 * Route a path to a Codex auth.json file.
 *
 * `echoPath` names the path in failure reasons. Pass false for anything typed
 * at the secret prompt: what looks like a path there may be a mistyped key,
 * and a diagnostic must never carry it to the terminal.
 */
export function routeCodexAuthFile(file: string, homedir: string, echoPath = true): CodexRoute {
  const resolved = path.resolve(expandHome(file.trim(), homedir));
  const name = echoPath ? resolved : "That path";
  let text: string;
  try {
    if (!fs.statSync(resolved).isFile()) return { ok: false, reason: `${name} is not a file.` };
    text = fs.readFileSync(resolved, "utf-8");
  } catch {
    return {
      ok: false,
      reason: echoPath
        ? `Cannot read ${resolved}.`
        : "Not an OpenAI API key (sk-...), a Codex auth.json, or a readable path to one.",
    };
  }
  const routed = routeCodexAuthJson(text);
  return routed.ok ? routed : { ok: false, reason: `${name}: ${routed.reason}` };
}

/** Drop one pair of matching surrounding quotes, as a copied shell value often has. */
export function stripQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === "\"" || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1).trim();
  return v;
}

/**
 * Route a pasted Codex credential by its shape, mirroring
 * routeAnthropicCredential:
 *
 *   {...}            the contents of an auth.json   -> CODEX_AUTH_JSON
 *   sk-...           an OpenAI API key              -> OPENAI_API_KEY
 *   anything else    a path to an auth.json file    -> CODEX_AUTH_JSON
 */
export function routeCodexCredential(raw: string, homedir: string): CodexRoute {
  const value = stripQuotes(raw);
  if (!value) return { ok: false, reason: "Empty." };
  if (value.startsWith("{")) return routeCodexAuthJson(value);
  if (value.startsWith("sk-")) return routeOpenAIApiKey(value);
  // Never echo it: this came from the secret prompt.
  return routeCodexAuthFile(value, homedir, false);
}

// ---------------------------------------------------------------------------
// Does this install pass OPENAI_API_KEY to the platform?
// ---------------------------------------------------------------------------
//
// Writing OPENAI_API_KEY to .env does nothing unless the compose file hands it
// to the container that provisions codex phases. The vendored template gains
// that line with the platform release that adds API-key support
// (syntropic137/syntropic137#1971), so the option is gated on the template
// itself, never on a version number: once the template sync brings the line,
// it turns on by itself.

/** One `KEY: ${KEY...}` (or `- KEY=${KEY...}`) environment entry forwarding KEY. */
function forwards(block: string, key: string): boolean {
  return new RegExp(`^\\s+(?:-\\s*)?${key}\\s*[:=]\\s*["']?\\$\\{${key}[:}-]`, "m").test(block);
}

/**
 * True when the service that receives CODEX_AUTH_JSON also receives
 * OPENAI_API_KEY in this compose file. Same service, because that is the one
 * that stages the codex credential.
 */
export function composeForwardsOpenAIKey(composeText: string): boolean {
  const blocks: string[] = [];
  let inServices = false;
  for (const line of composeText.split("\n")) {
    if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment, at any indent
    if (/^\S/.test(line)) {
      inServices = /^services:\s*$/.test(line);
      continue;
    }
    if (!inServices) continue;
    if (/^  [A-Za-z0-9_.-]+:\s*$/.test(line)) {
      blocks.push("");
      continue;
    }
    if (blocks.length > 0) blocks[blocks.length - 1] += line + "\n";
  }
  return blocks.some((b) => forwards(b, ENV_KEYS.CODEX_AUTH_JSON) && forwards(b, ENV_KEYS.OPENAI_API_KEY));
}

/** Read the install's compose file; false when it is missing or does not forward the key. */
export function installForwardsOpenAIKey(installDir: string): boolean {
  try {
    return composeForwardsOpenAIKey(fs.readFileSync(path.join(installDir, COMPOSE_FILE), "utf-8"));
  } catch {
    return false;
  }
}

/** Why an OpenAI API key cannot be used on this install yet. */
export const API_KEY_UNSUPPORTED =
  `This install's ${COMPOSE_FILE} does not pass ${ENV_KEYS.OPENAI_API_KEY} to the platform yet. ` +
  "That needs the Syntropic137 release with syntropic137/syntropic137#1971 and the setup templates synced from it. Use a Codex auth.json instead.";

// ---------------------------------------------------------------------------
// This machine's Codex login
// ---------------------------------------------------------------------------

/** Where `codex` keeps its login: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function localCodexAuthPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const home = env.CODEX_HOME?.trim() || path.join(homedir, ".codex");
  return path.join(home, "auth.json");
}

export type LocalCodexAuth =
  /** API-key mode login: no refresh token, safe to reuse. */
  | { mode: "apikey"; path: string; apiKey: CodexCredential }
  /** Plan login: reusing it shares a single-use refresh token (#893). */
  | { mode: "plan"; path: string; credential: CodexCredential };

/** Read this machine's Codex login, or null when there is none usable. */
export function readLocalCodexAuth(env: NodeJS.ProcessEnv, homedir: string): LocalCodexAuth | null {
  const file = localCodexAuthPath(env, homedir);
  if (!fs.existsSync(file)) return null;
  const routed = routeCodexAuthFile(file, homedir);
  if (!routed.ok) return null;
  const parsed = JSON.parse(routed.value) as Record<string, unknown>;
  if (parsed.auth_mode === "apikey") {
    const key = typeof parsed.OPENAI_API_KEY === "string" ? routeOpenAIApiKey(parsed.OPENAI_API_KEY) : null;
    return key?.ok ? { mode: "apikey", path: file, apiKey: key } : null;
  }
  return { mode: "plan", path: file, credential: routed };
}

/** The #893 warning, as lines. Shown before every reuse of this machine's plan login. */
export function sharedRefreshTokenWarning(file: string): { warning: string; details: string[] } {
  return {
    warning: `Reusing ${file} shares one Codex login between this machine and the platform.`,
    details: [
      "Codex refresh tokens are single use: when one side refreshes, the other is logged out",
      "with refresh_token_reused (syntropic137/syntropic137#893).",
      "Recommended instead: a dedicated login (`CODEX_HOME=$(mktemp -d) codex login`, then",
      "give setup that directory's auth.json), or an OpenAI API key.",
    ],
  };
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export interface CodexStepOptions {
  /** `--skip-codex` */
  skip?: boolean;
  /** `--codex-auth-file <path>` */
  authFile?: string;
  /** `--openai-api-key-env <VAR>`: the NAME of an env var holding the key. */
  apiKeyEnv?: string;
  /** `--yes` */
  yes?: boolean;
  /**
   * Ask "Enable Codex phases?" first. True in init, false in the `codex`
   * command, where running the command already says yes.
   */
  askToEnable: boolean;
}

export interface CodexStepDeps {
  interactive: boolean;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** Is this binary on PATH? */
  locate: (bin: string) => boolean;
  /**
   * Does this install's compose file forward OPENAI_API_KEY to the platform
   * (installForwardsOpenAIKey)? When false, an API key is refused, not stored.
   */
  apiKeySupported: boolean;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  promptSecret: (question: string) => Promise<string>;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  success: (msg: string) => void;
}

export type CodexStepResult =
  | { status: "enabled"; credential: CodexCredential }
  | { status: "skipped" };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Collect an optional Codex credential. Never throws and never prints the
 * value: a problem is a warning and a skip, like the Anthropic step.
 */
export async function codexCredentialStep(opts: CodexStepOptions, deps: CodexStepDeps): Promise<CodexStepResult> {
  const { info, warn } = deps;
  const skipped = (): CodexStepResult => {
    info(`Add Codex later: ${CMD.codex}`);
    return { status: "skipped" };
  };
  // Read this machine's login only when a decision needs it.
  let localRead = false;
  let localCache: LocalCodexAuth | null = null;
  const localAuth = (): LocalCodexAuth | null => {
    if (!localRead) {
      localCache = readLocalCodexAuth(deps.env, deps.homedir);
      localRead = true;
    }
    return localCache;
  };

  /** Gate a plan login that is this machine's own on consent after the #893 warning. */
  const consentToReuse = async (cred: CodexCredential): Promise<boolean> => {
    if (!cred.refreshToken) return true;
    const local = localAuth();
    if (!(local?.mode === "plan" && cred.refreshToken === local.credential.refreshToken)) {
      return true;
    }
    const w = sharedRefreshTokenWarning(local.path);
    warn(w.warning);
    for (const l of w.details) info(l);
    if (deps.interactive) return deps.confirm("Use it anyway?", false);
    if (opts.yes) {
      info("Proceeding because --yes was given.");
      return true;
    }
    info("Not used: without a terminal, pass --yes to accept this.");
    return false;
  };

  const enable = (cred: CodexCredential): CodexStepResult => {
    deps.success(`Codex enabled: ${codexKindLabel(cred.kind)}, stored as ${cred.envKey}.`);
    return { status: "enabled", credential: cred };
  };

  const fromRoute = async (routed: CodexRoute, what: string): Promise<CodexStepResult> => {
    if (!routed.ok) {
      warn(`${what}: ${routed.reason} Skipping Codex.`);
      return skipped();
    }
    if (routed.kind === "api-key" && !deps.apiKeySupported) {
      warn(`${API_KEY_UNSUPPORTED} Skipping Codex.`);
      return skipped();
    }
    if (!(await consentToReuse(routed))) return skipped();
    return enable(routed);
  };

  // ── Explicit choices first: flags, then the environment ──────────────
  if (opts.skip) {
    info("Skipped (--skip-codex).");
    return skipped();
  }
  if (opts.apiKeyEnv !== undefined) {
    const name = opts.apiKeyEnv;
    if (!ENV_VAR_NAME_RE.test(name)) {
      // Never echo it: a key passed here by mistake must not reach the terminal.
      warn("--openai-api-key-env takes the NAME of an environment variable (for example OPENAI_API_KEY), not the key. Skipping Codex.");
      return skipped();
    }
    const raw = deps.env[name];
    if (!raw) {
      warn(`${name} is not set. Skipping Codex.`);
      return skipped();
    }
    return fromRoute(routeOpenAIApiKey(raw), name);
  }
  if (opts.authFile !== undefined) {
    return fromRoute(routeCodexAuthFile(opts.authFile, deps.homedir), "--codex-auth-file");
  }
  const fromEnv = deps.env[ENV_KEYS.CODEX_AUTH_JSON];
  if (fromEnv) {
    info(`Found ${ENV_KEYS.CODEX_AUTH_JSON} in environment.`);
    return fromRoute(routeCodexAuthJson(fromEnv), ENV_KEYS.CODEX_AUTH_JSON);
  }

  // ── No terminal: never ask, never guess ──────────────────────────────
  if (!deps.interactive) {
    info(deps.apiKeySupported
      ? "Skipped (non-interactive). Pass --codex-auth-file <path> or --openai-api-key-env <VAR> to enable Codex phases."
      : "Skipped (non-interactive). Pass --codex-auth-file <path> to enable Codex phases.");
    return skipped();
  }

  // ── Interactive ──────────────────────────────────────────────────────
  if (opts.askToEnable) {
    info(deps.apiKeySupported
      ? "Codex phases (agent.provider: codex) need a Codex login or an OpenAI API key."
      : "Codex phases (agent.provider: codex) need a Codex login (auth.json).");
    const enableIt = await deps.confirm("Enable Codex phases?", deps.locate("codex"));
    if (!enableIt) {
      info("Skipped.");
      return skipped();
    }
  }

  const local = localAuth();
  if (local?.mode === "apikey") {
    if (deps.apiKeySupported) {
      // No refresh token, so nothing to collide on: offer it plainly.
      if (await deps.confirm(`Use the OpenAI API key from ${local.path}?`, true)) return enable(local.apiKey);
    } else {
      // Never turn a working login into a config this install cannot use.
      info(`${local.path} is an API-key login. ${API_KEY_UNSUPPORTED}`);
    }
  } else if (local?.mode === "plan") {
    const w = sharedRefreshTokenWarning(local.path);
    warn(w.warning);
    for (const l of w.details) info(l);
    if (await deps.confirm(`Use ${local.path} anyway?`, false)) return enable(local.credential);
  }

  info(deps.apiKeySupported
    ? "Paste an OpenAI API key (sk-...), or the path to a Codex auth.json."
    : "Paste the path to a Codex auth.json (OpenAI API keys need a newer platform: syntropic137/syntropic137#1971).");
  info("Dedicated login: `CODEX_HOME=$(mktemp -d) codex login`, then give the auth.json it writes.");
  const raw = (await deps.promptSecret("Codex credential")).trim();
  if (!raw) {
    info("No credential provided.");
    return skipped();
  }
  // The pasted login may still be this machine's own (pasted by path or by
  // content after declining above): the same warning and consent apply.
  return fromRoute(routeCodexCredential(raw, deps.homedir), "Codex credential");
}

/** The Codex outcome as one plain line (summary, and the --skip-docker ending). */
export function codexOutcomeText(outcome: { enabled: true; kind: CodexCredentialKind } | { enabled: false }): string {
  return outcome.enabled
    ? `Codex enabled (${codexKindLabel(outcome.kind)}).`
    : `Codex skipped. Add it later: ${CMD.codex}`;
}

/**
 * Apply a Codex choice to a set of .env values: write the chosen key and drop
 * the other, so the platform never sees two credentials that disagree.
 */
export function applyCodexCredential<T extends Record<string, string | undefined>>(env: T, cred: CodexCredential): T {
  const out: Record<string, string | undefined> = { ...env };
  delete out[ENV_KEYS.CODEX_AUTH_JSON];
  delete out[ENV_KEYS.OPENAI_API_KEY];
  out[cred.envKey] = cred.value;
  return out as T;
}
