import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyCodexCredential,
  codexCredentialStep,
  localCodexAuthPath,
  readLocalCodexAuth,
  routeCodexAuthJson,
  routeCodexCredential,
  routeOpenAIApiKey,
  type CodexStepDeps,
  type CodexStepOptions,
} from "./codex.js";
import { ENV_KEYS } from "./constants.js";

// Every value here is invented. None is a real credential.
const API_KEY = "sk-proj-INVENTED-test-key-0000000000000000";
const OTHER_API_KEY = "sk-proj-INVENTED-other-key-111111111111111";
const REFRESH = "rt_INVENTED_refresh_token_for_tests";
const ACCESS = "eyINVENTED.access.token";
const planAuth = (refresh = REFRESH) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: "eyINVENTED.id", access_token: ACCESS, refresh_token: refresh, account_id: "acct-invented" },
  last_refresh: "2026-10-14T00:00:00Z",
});
const apikeyAuth = (key = API_KEY) => ({ auth_mode: "apikey", OPENAI_API_KEY: key });

let tmp: string;
let home: string;
let codexHome: string;

beforeEach(() => {
  tmp = path.join(os.tmpdir(), `s137-codex-test-${crypto.randomUUID()}`);
  home = path.join(tmp, "home");
  codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Write a pretty-printed auth.json, the way `codex login` does. */
function writeAuth(file: string, content: unknown): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + "\n", { mode: 0o600 });
  return file;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("routeCodexCredential: routes by shape", () => {
  it("routes an OpenAI API key (sk-...) to OPENAI_API_KEY", () => {
    const r = routeCodexCredential(`  ${API_KEY}\n`, home);
    expect(r).toMatchObject({ ok: true, envKey: ENV_KEYS.OPENAI_API_KEY, value: API_KEY, kind: "api-key", refreshToken: null });
  });

  it("refuses an Anthropic key pasted into the Codex prompt", () => {
    const r = routeCodexCredential("sk-ant-api03-INVENTED-0000000000000000", home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Anthropic");
  });

  it("refuses a key with spaces or that is too short", () => {
    expect(routeCodexCredential("sk-short", home).ok).toBe(false);
    expect(routeOpenAIApiKey("sk-proj-has a space-0000000000000").ok).toBe(false);
  });

  it("routes pasted auth.json content to CODEX_AUTH_JSON, as one line", () => {
    const r = routeCodexCredential(JSON.stringify(planAuth()), home);
    expect(r).toMatchObject({ ok: true, envKey: ENV_KEYS.CODEX_AUTH_JSON, kind: "auth-json", refreshToken: REFRESH });
    if (r.ok) {
      expect(r.value).not.toMatch(/[\r\n ]/);
      expect(JSON.parse(r.value)).toEqual(planAuth());
    }
  });

  it("routes a path to a pretty-printed auth.json, expanding ~", () => {
    writeAuth(path.join(home, "dedicated", "auth.json"), planAuth());
    const r = routeCodexCredential("~/dedicated/auth.json", home);
    expect(r).toMatchObject({ ok: true, envKey: ENV_KEYS.CODEX_AUTH_JSON, kind: "auth-json" });
    if (r.ok) {
      expect(r.value.split("\n")).toHaveLength(1);
      expect(JSON.parse(r.value)).toEqual(planAuth());
    }
  });

  it("keeps an API-key mode auth.json as CODEX_AUTH_JSON when given as a file or JSON", () => {
    const r = routeCodexCredential(JSON.stringify(apikeyAuth()), home);
    expect(r).toMatchObject({ ok: true, envKey: ENV_KEYS.CODEX_AUTH_JSON, refreshToken: null });
  });

  it("refuses JSON that is not a Codex auth.json", () => {
    expect(routeCodexAuthJson("{not json").ok).toBe(false);
    expect(routeCodexAuthJson("[1,2]").ok).toBe(false);
    expect(routeCodexAuthJson("null").ok).toBe(false);
    const r = routeCodexAuthJson(JSON.stringify({ tokens: {} }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("auth_mode");
  });

  it("refuses a value Docker Compose would rewrite ($ interpolation)", () => {
    const r = routeCodexAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "a$b" } }));
    expect(r.ok).toBe(false);
  });

  it("refuses a path that does not exist, without echoing file contents", () => {
    const r = routeCodexCredential("/no/such/auth.json", home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("/no/such/auth.json");
  });

  it("refuses an empty value", () => {
    expect(routeCodexCredential("   ", home).ok).toBe(false);
  });
});

describe("this machine's Codex login", () => {
  it("lives in $CODEX_HOME when set, else ~/.codex", () => {
    expect(localCodexAuthPath({}, home)).toBe(path.join(home, ".codex", "auth.json"));
    expect(localCodexAuthPath({ CODEX_HOME: "/x/codex" }, home)).toBe("/x/codex/auth.json");
  });

  it("reads an API-key mode login as an API key", () => {
    writeAuth(path.join(codexHome, "auth.json"), apikeyAuth());
    const local = readLocalCodexAuth({}, home);
    expect(local?.mode).toBe("apikey");
    if (local?.mode === "apikey") expect(local.apiKey).toMatchObject({ envKey: ENV_KEYS.OPENAI_API_KEY, value: API_KEY });
  });

  it("reads a plan login with its refresh token", () => {
    writeAuth(path.join(codexHome, "auth.json"), planAuth());
    const local = readLocalCodexAuth({}, home);
    expect(local?.mode).toBe("plan");
    if (local?.mode === "plan") expect(local.credential.refreshToken).toBe(REFRESH);
  });

  it("is null when missing or unreadable", () => {
    expect(readLocalCodexAuth({}, home)).toBeNull();
    fs.writeFileSync(path.join(codexHome, "auth.json"), "garbage");
    expect(readLocalCodexAuth({}, home)).toBeNull();
  });
});

describe("applyCodexCredential", () => {
  it("writes the chosen key and removes the other", () => {
    const env = { A: "1", [ENV_KEYS.CODEX_AUTH_JSON]: "{\"auth_mode\":\"old\"}" };
    const r = routeOpenAIApiKey(API_KEY);
    if (!r.ok) throw new Error("expected ok");
    const out = applyCodexCredential(env, r);
    expect(out).toEqual({ A: "1", [ENV_KEYS.OPENAI_API_KEY]: API_KEY });
  });
});

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

interface Harness {
  deps: CodexStepDeps;
  confirm: ReturnType<typeof vi.fn>;
  promptSecret: ReturnType<typeof vi.fn>;
  /** Everything printed, in order, tagged by channel. */
  out: string[];
}

function harness(over: Partial<CodexStepDeps> & { answers?: boolean[]; pasted?: string; onPathCodex?: boolean } = {}): Harness {
  const out: string[] = [];
  const answers = [...(over.answers ?? [])];
  const confirm = vi.fn(async (q: string, _d?: boolean) => {
    out.push(`confirm: ${q}`);
    return answers.length > 0 ? answers.shift()! : false;
  });
  const promptSecret = vi.fn(async (q: string) => {
    out.push(`secret: ${q}`);
    return over.pasted ?? "";
  });
  const deps: CodexStepDeps = {
    interactive: over.interactive ?? true,
    env: over.env ?? {},
    homedir: home,
    locate: (bin) => bin === "codex" && (over.onPathCodex ?? false),
    confirm,
    promptSecret,
    info: (m) => out.push(`info: ${m}`),
    warn: (m) => out.push(`warn: ${m}`),
    success: (m) => out.push(`success: ${m}`),
  };
  return { deps, confirm, promptSecret, out };
}

const initOpts = (o: Partial<CodexStepOptions> = {}): CodexStepOptions => ({ askToEnable: true, ...o });

/** No printed line may carry a secret (#78/#79: never print values). */
function expectNoSecretPrinted(out: string[]): void {
  for (const line of out) {
    for (const secret of [API_KEY, OTHER_API_KEY, REFRESH, ACCESS]) expect(line).not.toContain(secret);
  }
}

const warnedAbout893 = (out: string[]) => out.some((l) => l.startsWith("warn:") && l.includes("shares one Codex login"))
  && out.some((l) => l.includes("#893") && l.includes("refresh_token_reused"));

describe("codexCredentialStep: flags and environment (agents, --yes)", () => {
  it("--skip-codex skips without asking", async () => {
    const h = harness();
    expect(await codexCredentialStep(initOpts({ skip: true }), h.deps)).toEqual({ status: "skipped" });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.out.some((l) => l.includes("npx @syntropic137/setup codex"))).toBe(true);
  });

  it("--openai-api-key-env reads the key from the NAMED variable", async () => {
    const h = harness({ interactive: false, env: { MY_OPENAI_KEY: API_KEY } });
    const r = await codexCredentialStep(initOpts({ apiKeyEnv: "MY_OPENAI_KEY" }), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.OPENAI_API_KEY, value: API_KEY } });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.out.some((l) => l.includes("#1971"))).toBe(true);
    expectNoSecretPrinted(h.out);
  });

  it("--openai-api-key-env with an unset variable skips", async () => {
    const h = harness({ interactive: false });
    expect((await codexCredentialStep(initOpts({ apiKeyEnv: "UNSET_VAR" }), h.deps)).status).toBe("skipped");
    expect(h.out.some((l) => l.startsWith("warn:") && l.includes("UNSET_VAR is not set"))).toBe(true);
  });

  it("--openai-api-key-env given the key itself skips and never echoes it", async () => {
    const h = harness({ interactive: false, env: { [API_KEY]: "x" } });
    expect((await codexCredentialStep(initOpts({ apiKeyEnv: API_KEY }), h.deps)).status).toBe("skipped");
    expectNoSecretPrinted(h.out);
  });

  it("--openai-api-key-env holding an Anthropic key skips", async () => {
    const h = harness({ interactive: false, env: { K: "sk-ant-api03-INVENTED-00000000000000" } });
    expect((await codexCredentialStep(initOpts({ apiKeyEnv: "K" }), h.deps)).status).toBe("skipped");
  });

  it("--codex-auth-file stores a dedicated login without asking", async () => {
    const file = writeAuth(path.join(tmp, "dedicated", "auth.json"), planAuth("rt_INVENTED_dedicated"));
    writeAuth(path.join(codexHome, "auth.json"), planAuth());
    const h = harness({ interactive: false });
    const r = await codexCredentialStep(initOpts({ authFile: file }), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.CODEX_AUTH_JSON, kind: "auth-json" } });
    expect(warnedAbout893(h.out)).toBe(false);
    expectNoSecretPrinted(h.out);
  });

  it("--codex-auth-file with a bad file skips with the reason", async () => {
    const h = harness({ interactive: false });
    expect((await codexCredentialStep(initOpts({ authFile: path.join(tmp, "missing.json") }), h.deps)).status).toBe("skipped");
    expect(h.out.some((l) => l.startsWith("warn:") && l.includes("missing.json"))).toBe(true);
  });

  it("CODEX_AUTH_JSON in the environment is used", async () => {
    const h = harness({ interactive: false, env: { [ENV_KEYS.CODEX_AUTH_JSON]: JSON.stringify(planAuth("rt_INVENTED_env")) } });
    const r = await codexCredentialStep(initOpts(), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.CODEX_AUTH_JSON } });
  });

  it("an OPENAI_API_KEY already in the environment is NOT picked up silently", async () => {
    const h = harness({ interactive: false, env: { OPENAI_API_KEY: API_KEY } });
    expect((await codexCredentialStep(initOpts({ yes: true }), h.deps)).status).toBe("skipped");
  });

  it("without a terminal and no flag, skips without prompting, even with --yes", async () => {
    for (const yes of [false, true]) {
      writeAuth(path.join(codexHome, "auth.json"), apikeyAuth());
      const h = harness({ interactive: false, onPathCodex: true });
      expect((await codexCredentialStep(initOpts({ yes }), h.deps)).status).toBe("skipped");
      expect(h.confirm).not.toHaveBeenCalled();
      expect(h.promptSecret).not.toHaveBeenCalled();
      expect(h.out.some((l) => l.includes("--codex-auth-file") && l.includes("--openai-api-key-env"))).toBe(true);
    }
  });
});

describe("codexCredentialStep: reusing this machine's plan login needs the #893 warning and consent", () => {
  beforeEach(() => {
    writeAuth(path.join(codexHome, "auth.json"), planAuth());
  });

  it("--codex-auth-file pointing at it, no terminal, no --yes: warns and skips", async () => {
    const h = harness({ interactive: false });
    const r = await codexCredentialStep(initOpts({ authFile: path.join(codexHome, "auth.json") }), h.deps);
    expect(r.status).toBe("skipped");
    expect(warnedAbout893(h.out)).toBe(true);
    expect(h.out.some((l) => l.includes("--yes"))).toBe(true);
  });

  it("--codex-auth-file pointing at it with --yes: warns, then uses it", async () => {
    const h = harness({ interactive: false });
    const r = await codexCredentialStep(initOpts({ authFile: path.join(codexHome, "auth.json"), yes: true }), h.deps);
    expect(r.status).toBe("enabled");
    expect(warnedAbout893(h.out)).toBe(true);
    expectNoSecretPrinted(h.out);
  });

  it("CODEX_AUTH_JSON in the env holding the same login gets the same gate", async () => {
    const h = harness({ interactive: false, env: { [ENV_KEYS.CODEX_AUTH_JSON]: JSON.stringify(planAuth()) } });
    expect((await codexCredentialStep(initOpts(), h.deps)).status).toBe("skipped");
    expect(warnedAbout893(h.out)).toBe(true);
  });

  it("interactive offer: warning first, then a default-no question; yes uses it", async () => {
    const h = harness({ answers: [true, true] });
    const r = await codexCredentialStep(initOpts(), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.CODEX_AUTH_JSON, refreshToken: REFRESH } });
    const warnAt = h.out.findIndex((l) => l.startsWith("warn:") && l.includes("shares one Codex login"));
    const askAt = h.out.findIndex((l) => l.startsWith("confirm:") && l.includes("anyway"));
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(askAt).toBeGreaterThan(warnAt);
    const reuseCall = h.confirm.mock.calls.find((c) => String(c[0]).includes("anyway"))!;
    expect(reuseCall[1]).toBe(false);
    expect(h.promptSecret).not.toHaveBeenCalled();
  });

  it("interactive: declining falls through to the prompt, where an API key works", async () => {
    const h = harness({ answers: [true, false], pasted: OTHER_API_KEY });
    const r = await codexCredentialStep(initOpts(), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.OPENAI_API_KEY, value: OTHER_API_KEY } });
    expectNoSecretPrinted(h.out);
  });

  it("interactive: declining, then pasting the same file's path, asks again (default no)", async () => {
    const h = harness({ answers: [true, false, false], pasted: path.join(codexHome, "auth.json") });
    expect((await codexCredentialStep(initOpts(), h.deps)).status).toBe("skipped");
    expect(h.confirm.mock.calls.filter((c) => String(c[0]).includes("anyway"))).toHaveLength(2);
  });
});

describe("codexCredentialStep: interactive", () => {
  it("asks 'Enable Codex phases?' defaulting to yes when codex is on PATH", async () => {
    const h = harness({ onPathCodex: true });
    await codexCredentialStep(initOpts(), h.deps);
    expect(h.confirm.mock.calls[0]).toEqual(["Enable Codex phases?", true]);
  });

  it("defaults to no when codex is not on PATH, and declining skips", async () => {
    const h = harness({ onPathCodex: false, answers: [false] });
    expect((await codexCredentialStep(initOpts(), h.deps)).status).toBe("skipped");
    expect(h.confirm.mock.calls[0]).toEqual(["Enable Codex phases?", false]);
    expect(h.promptSecret).not.toHaveBeenCalled();
  });

  it("offers an API-key mode login as an API key, with no #893 warning", async () => {
    writeAuth(path.join(codexHome, "auth.json"), apikeyAuth());
    const h = harness({ answers: [true, true] });
    const r = await codexCredentialStep(initOpts(), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.OPENAI_API_KEY, value: API_KEY, kind: "api-key" } });
    expect(warnedAbout893(h.out)).toBe(false);
    expectNoSecretPrinted(h.out);
  });

  it("with no local login, a pasted auth.json path is stored", async () => {
    const file = writeAuth(path.join(tmp, "dedicated", "auth.json"), planAuth("rt_INVENTED_dedicated"));
    const h = harness({ answers: [true], pasted: file });
    const r = await codexCredentialStep(initOpts(), h.deps);
    expect(r).toMatchObject({ status: "enabled", credential: { envKey: ENV_KEYS.CODEX_AUTH_JSON } });
  });

  it("an empty paste skips; an invalid one warns and skips", async () => {
    let h = harness({ answers: [true], pasted: "" });
    expect((await codexCredentialStep(initOpts(), h.deps)).status).toBe("skipped");
    h = harness({ answers: [true], pasted: "sk-ant-api03-INVENTED-0000000000000000" });
    expect((await codexCredentialStep(initOpts(), h.deps)).status).toBe("skipped");
    expect(h.out.some((l) => l.startsWith("warn:") && l.includes("Anthropic"))).toBe(true);
  });

  it("the codex command does not ask 'Enable Codex phases?'", async () => {
    const h = harness({ pasted: API_KEY });
    const r = await codexCredentialStep({ askToEnable: false }, h.deps);
    expect(r.status).toBe("enabled");
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
