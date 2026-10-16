import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Mock UI — silence all output, preset interactive responses
vi.mock("./ui.js", () => ({
  banner: vi.fn(),
  step: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  bold: (s: string) => s,
  dim: (s: string) => s,
  green: (s: string) => s,
  cyan: (s: string) => s,
  setTotalSteps: vi.fn(),
  prompt: vi.fn().mockResolvedValue(""),
  promptSecret: vi.fn().mockResolvedValue("sk-ant-test-key-123"),
  confirm: vi.fn().mockResolvedValue(true),
  setupOverview: vi.fn(),
  summaryBox: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
  interactiveMenu: vi.fn().mockResolvedValue("cloudflare"),
}));

// Mock Docker — not needed with --skip-docker but prevents accidental calls
vi.mock("./docker.js", () => ({
  checkDocker: vi.fn(),
  DockerService: vi.fn().mockImplementation(() => ({
    pull: vi.fn(),
    up: vi.fn(),
    down: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    logs: vi.fn(),
    status: vi.fn(),
    update: vi.fn(),
    waitForHealth: vi.fn().mockResolvedValue(true),
  })),
  parseComposeVersion: vi.fn(),
}));

// Mock agent skills: never run npx or touch the real ~/.claude / ~/.agents
const { skillsInstall, onPathMock } = vi.hoisted(() => ({ skillsInstall: vi.fn(), onPathMock: vi.fn() }));
vi.mock("./skills.js", () => ({
  defaultRunner: vi.fn(),
  onPath: onPathMock,
  SkillsManager: vi.fn().mockImplementation(() => ({
    install: skillsInstall,
    status: vi.fn().mockResolvedValue(true),
  })),
}));

// Mock manifest flow — returns fake credentials
vi.mock("./manifest.js", () => {
  const result = {
    id: 42,
    slug: "test-syntropic137",
    pem: "fake-pem-content",
    webhook_secret: "wh-secret-abc",
    client_id: "Iv1.abc123",
    client_secret: "cs-secret-xyz",
    html_url: "https://github.com/settings/apps/test-syntropic137",
  };
  return {
    GitHubAppSetup: vi.fn().mockImplementation(() => ({
      run: vi.fn().mockResolvedValue(result),
    })),
    openBrowser: vi.fn(),
    runManifestFlow: vi.fn().mockResolvedValue(result),
    buildManifest: vi.fn(),
  };
});

// Never run npm or syn for real: `syn version` reports "not installed" and
// every npm call is recorded instead of installing anything globally.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// Templates are copied for real. A test can stand in a compose file "synced
// from a newer platform" (one that forwards OPENAI_API_KEY, #1971): the copy
// runs, then the override replaces what landed in the install.
const { composeOverride } = vi.hoisted(() => ({ composeOverride: { text: null as string | null } }));
vi.mock("./templates.js", async () => {
  const actual = await vi.importActual<typeof import("./templates.js")>("./templates.js");
  return {
    ...actual,
    syncTemplate: (tplDir: string, installDir: string, relativePath: string) => {
      actual.syncTemplate(tplDir, installDir, relativePath);
      if (relativePath === "docker-compose.syntropic137.yaml" && composeOverride.text !== null) {
        fs.writeFileSync(path.join(installDir, relativePath), composeOverride.text);
      }
    },
  };
});

import { CLI, parseArgs, runInit } from "./cli.js";
import { confirm, promptSecret, summaryBox } from "./ui.js";
import { ENV_KEYS, GITHUB_SLUG_RE } from "./constants.js";
import { parseEnv } from "./config.js";
import { info } from "./ui.js";
import { TEMPLATES_DIR } from "./templates.js";

/** The vendored compose template, as shipped. */
const vendoredCompose = () => fs.readFileSync(path.join(TEMPLATES_DIR, "docker-compose.syntropic137.yaml"), "utf-8");
/** A compose file from a platform release that predates OPENAI_API_KEY forwarding (before v1.0.3). */
const composeWithoutOpenAIKey = () => vendoredCompose().replace(/^\s+OPENAI_API_KEY: \$\{OPENAI_API_KEY:-\}\n/gm, "");
/** The vendored template, synced from v1.0.3, which forwards OPENAI_API_KEY (#1971). */
const composeWithOpenAIKey = () => vendoredCompose();
/** Make the next init copy this compose file into the install (and leave it for the codex command). */
function seedCompose(_dir: string, text: string): void {
  composeOverride.text = text;
}
afterEach(() => {
  composeOverride.text = null;
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `s137-init-test-${crypto.randomUUID()}`);
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((cmd: string) => {
    if (cmd === "syn") throw new Error("syn: command not found");
    return "";
  });
});

/** Make stdin and stdout look like a terminal for the duration of `fn`. */
async function withTerminal(fn: () => Promise<void>): Promise<void> {
  const inDesc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const outDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    await fn();
  } finally {
    if (inDesc) Object.defineProperty(process.stdin, "isTTY", inDesc);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    if (outDesc) Object.defineProperty(process.stdout, "isTTY", outDesc);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
  }
}

const npmInstalls = () =>
  execFileSyncMock.mock.calls.filter((c) => c[0] === "npm" && (c[1] as string[])[0] === "install");

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("defaults to menu when no command given", () => {
    const opts = parseArgs(["node", "cli"]);
    expect(opts.command).toBe("menu");
  });

  it("recognizes explicit init command", () => {
    const opts = parseArgs(["node", "cli", "init"]);
    expect(opts.command).toBe("init");
  });

  it("recognizes subcommands", () => {
    expect(parseArgs(["node", "cli", "status"]).command).toBe("status");
    expect(parseArgs(["node", "cli", "stop"]).command).toBe("stop");
    expect(parseArgs(["node", "cli", "start"]).command).toBe("start");
    expect(parseArgs(["node", "cli", "logs"]).command).toBe("logs");
    expect(parseArgs(["node", "cli", "update"]).command).toBe("update");
    expect(parseArgs(["node", "cli", "skills"]).command).toBe("skills");
    expect(parseArgs(["node", "cli", "plugin"]).command).toBe("plugin");
    expect(parseArgs(["node", "cli", "github-app"]).command).toBe("github-app");
    expect(parseArgs(["node", "cli", "tunnel"]).command).toBe("tunnel");
    expect(parseArgs(["node", "cli", "cli"]).command).toBe("cli");
  });

  it("parses skills sub-actions, defaulting to install", () => {
    expect(parseArgs(["node", "cli", "skills"]).skillsAction).toBeUndefined();
    expect(parseArgs(["node", "cli", "skills", "install"]).skillsAction).toBe("install");
    expect(parseArgs(["node", "cli", "skills", "update"]).skillsAction).toBe("update");
    expect(parseArgs(["node", "cli", "skills", "status"]).skillsAction).toBe("status");
    expect(parseArgs(["node", "cli", "skills", "--yes"]).skillsAction).toBeUndefined();
    expect(parseArgs(["node", "cli", "skills", "--yes", "status"]).skillsAction).toBe("status");
    expect(parseArgs(["node", "cli", "skills", "--dir", "/x", "update"]).skillsAction).toBe("update");
  });

  it("rejects unknown or surplus skills actions", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["node", "cli", "skills", "bogus"])).toThrow("exit 1");
    expect(() => parseArgs(["node", "cli", "skills", "status", "extra"])).toThrow("exit 1");
    exit.mockRestore();
  });

  it("parses reset flags, including --dir=value", () => {
    const o = parseArgs(["node", "cli", "reset", "--dir=/srv/syn", "--no-backup", "--all", "--yes"]);
    expect(o).toMatchObject({ command: "reset", dir: "/srv/syn", noBackup: true, images: true, cli: true, skills: true, yes: true });
    expect(parseArgs(["node", "cli", "reset", "--dir", "/srv/syn"]).dir).toBe("/srv/syn");
  });

  it("refuses a reset with a missing --dir value or an unknown argument", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["node", "cli", "reset", "--yes", "--dir"])).toThrow("exit 1");
    expect(() => parseArgs(["node", "cli", "reset", "--dir", "--yes"])).toThrow("exit 1");
    expect(() => parseArgs(["node", "cli", "reset", "--dri", "/x", "--yes"])).toThrow("exit 1");
    expect(() => parseArgs(["node", "cli", "reset", "everything"])).toThrow("exit 1");
    exit.mockRestore();
  });

  it("parses --yes and -y", () => {
    expect(parseArgs(["node", "cli", "skills", "--yes"]).yes).toBe(true);
    expect(parseArgs(["node", "cli", "skills", "install", "-y"]).yes).toBe(true);
    expect(parseArgs(["node", "cli", "skills"]).yes).toBeUndefined();
  });

  it("parses all flags", () => {
    const opts = parseArgs([
      "node", "cli", "init",
      "--org", "myorg",
      "--name", "myapp",
      "--dir", "/tmp/test",
      "--skip-github",
      "--skip-docker",
      "--webhook-url", "https://example.com/hook",
    ]);

    expect(opts.command).toBe("init");
    expect(opts.org).toBe("myorg");
    expect(opts.name).toBe("myapp");
    expect(opts.dir).toBe("/tmp/test");
    expect(opts.skipGithub).toBe(true);
    expect(opts.skipDocker).toBe(true);
    expect(opts.webhookUrl).toBe("https://example.com/hook");
  });
});

describe("runInit --skip-docker --skip-github", () => {
  it("creates full directory structure", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    expect(fs.existsSync(tmpDir)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "secrets"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "init-db"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "workspaces"))).toBe(true);
  });

  it("copies all template files", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    expect(fs.existsSync(path.join(tmpDir, "docker-compose.syntropic137.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "selfhost-entrypoint.sh"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "selfhost.env.example"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "init-db", "01-create-databases.sql"))).toBe(true);
  });

  it("generates secret files", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    const secretsDir = path.join(tmpDir, "secrets");
    expect(fs.existsSync(path.join(secretsDir, "db-password.secret"))).toBe(true);
    expect(fs.existsSync(path.join(secretsDir, "redis-password.secret"))).toBe(true);
    expect(fs.existsSync(path.join(secretsDir, "minio-password.secret"))).toBe(true);
  });

  it("writes .env with mode 0o600", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    const envPath = path.join(tmpDir, ".env");
    expect(fs.existsSync(envPath)).toBe(true);
    const stat = fs.statSync(envPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it(".env contains APP_ENVIRONMENT=selfhost", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("APP_ENVIRONMENT=selfhost");
  });

  it(".env contains SYN_INSTALL_DIR as an absolute path matching the install dir", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    const match = content.match(/^SYN_INSTALL_DIR=(.+)$/m);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(path.resolve(tmpDir));
    expect(path.isAbsolute(match![1]!)).toBe(true);
  });

  it("resolves a relative --dir to an absolute path in .env", async () => {
    const relativeDir = path.relative(process.cwd(), tmpDir);
    await runInit({ command: "init", dir: relativeDir, skipDocker: true, skipGithub: true });

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    const match = content.match(/^SYN_INSTALL_DIR=(.+)$/m);
    expect(match).not.toBeNull();
    expect(path.isAbsolute(match![1]!)).toBe(true);
  });
});

describe("runInit agent skills step", () => {
  beforeEach(() => skillsInstall.mockReset());

  it("installs the agent skills with --yes", async () => {
    skillsInstall.mockResolvedValue("installed");
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true });
    expect(skillsInstall).toHaveBeenCalledTimes(1);
  });

  it("skips the global install without a terminal or --yes", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    expect(skillsInstall).not.toHaveBeenCalled();
  });

  it("finishes setup when the skills install fails", async () => {
    skillsInstall.mockResolvedValue("failed");
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true });
    expect(fs.existsSync(path.join(tmpDir, ".env"))).toBe(true);
  });
});

describe("runInit credential step without a terminal", () => {
  const saved = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    vi.mocked(promptSecret).mockClear();
  });
  afterEach(() => {
    if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.oauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oauth;
  });

  // With stdin closed, the secret prompt waited on input that never came, the
  // event loop emptied, and init exited 0 at step 5 with no .env written.
  it("does not prompt, and still finishes the install", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    expect(promptSecret).not.toHaveBeenCalled();
    const env = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(env).toContain("APP_ENVIRONMENT=selfhost");
    expect(env).not.toMatch(/^ANTHROPIC_API_KEY=sk-/m);
  });

  it("still prompts when there is a terminal", async () => {
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true }));
    const anthropicPrompts = vi.mocked(promptSecret).mock.calls.filter((c) => String(c[0]).includes("Anthropic"));
    expect(anthropicPrompts).toHaveLength(1);
    const env = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(env).toMatch(/^ANTHROPIC_API_KEY=sk-ant-test-key-123$/m);
  });
});

describe("runInit syn CLI step", () => {
  it("installs the CLI without a terminal when --yes is given", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true });
    expect(npmInstalls()).toHaveLength(1);
    expect((npmInstalls()[0]![1] as string[]).join(" ")).toMatch(/^install -g @syntropic137\/cli@~\d+\.\d+\.\d+$/);
  });

  it("skips without a terminal or --yes, and says so", async () => {
    const { info } = await import("./ui.js");
    vi.mocked(info).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    expect(npmInstalls()).toHaveLength(0);
    const said = vi.mocked(info).mock.calls.map((c) => String(c[0]));
    expect(said.some((m) => m.includes("Skipped (non-interactive") && m.includes("--install-cli") && m.includes("setup cli"))).toBe(true);
  });

  it("asks in a terminal", async () => {
    vi.mocked(confirm).mockClear();
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true }));
    const asked = vi.mocked(confirm).mock.calls.map((c) => String(c[0]));
    expect(asked.some((q) => q.includes("@syntropic137/cli"))).toBe(true);
    expect(npmInstalls()).toHaveLength(1);
  });
});

describe("runInit with mocked GitHub flow", () => {
  it("writes app ID and slug to .env", async () => {
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true }));

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("SYN_GITHUB_APP_ID=42");
    expect(content).toContain("SYN_GITHUB_APP_NAME=test-syntropic137");
  });
});

describe("runInit without a terminal never waits on a person", () => {
  // Codex review of #84: without --skip-github, the "Create a GitHub App now?"
  // confirm (and then a browser callback) still stalled a closed-stdin init.
  it("skips the GitHub App instead of asking or opening a browser", async () => {
    const { GitHubAppSetup } = await import("./manifest.js");
    vi.mocked(GitHubAppSetup).mockClear();
    vi.mocked(confirm).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipDocker: true });
    expect(GitHubAppSetup).not.toHaveBeenCalled();
    expect(vi.mocked(confirm).mock.calls.map((c) => String(c[0])).some((q) => q.includes("GitHub App"))).toBe(false);
    const env = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(env).toContain("APP_ENVIRONMENT=selfhost");
    expect(env).not.toContain("SYN_GITHUB_APP_ID=42");
  });

  it("keeps an existing install as it is, without asking to reconfigure", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=true");
    vi.mocked(confirm).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8")).toBe("EXISTING=true");
  });
});

describe("runInit --install-cli / --no-install-cli", () => {
  it("parses both flags", () => {
    expect(parseArgs(["node", "cli", "init", "--install-cli"]).installCli).toBe(true);
    expect(parseArgs(["node", "cli", "init", "--no-install-cli"]).installCli).toBe(false);
    expect(parseArgs(["node", "cli", "init"]).installCli).toBeUndefined();
  });

  it("--install-cli installs without a terminal", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, installCli: true });
    expect(npmInstalls()).toHaveLength(1);
  });

  it("--no-install-cli skips even with --yes in a terminal, without asking", async () => {
    vi.mocked(confirm).mockClear();
    await withTerminal(() =>
      runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true, installCli: false }),
    );
    expect(npmInstalls()).toHaveLength(0);
    expect(vi.mocked(confirm).mock.calls.some((c) => String(c[0]).includes("@syntropic137/cli"))).toBe(false);
  });

  // The coordinator's report: --yes still asked yes/no for the CLI in a terminal.
  it("--yes installs in a terminal without asking", async () => {
    vi.mocked(confirm).mockClear();
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true }));
    expect(npmInstalls()).toHaveLength(1);
    expect(vi.mocked(confirm).mock.calls.some((c) => String(c[0]).includes("@syntropic137/cli"))).toBe(false);
  });
});

describe("runInit re-run safety", () => {
  it("detects existing .env and respects decline to reconfigure", async () => {
    // Pre-create install dir with .env
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=true");

    // Mock confirm to return false (decline reconfigure)
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true }));

    // Original .env should be untouched
    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toBe("EXISTING=true");
  });
});

describe("GITHUB_SLUG_RE", () => {
  it("accepts valid GitHub slugs", () => {
    expect(GITHUB_SLUG_RE.test("syntropic137")).toBe(true);
    expect(GITHUB_SLUG_RE.test("my-app")).toBe(true);
    expect(GITHUB_SLUG_RE.test("App123")).toBe(true);
  });

  it("rejects slugs with unsafe characters", () => {
    expect(GITHUB_SLUG_RE.test("foo&bar")).toBe(false);
    expect(GITHUB_SLUG_RE.test("foo|bar")).toBe(false);
    expect(GITHUB_SLUG_RE.test("foo bar")).toBe(false);
    expect(GITHUB_SLUG_RE.test("foo;rm -rf")).toBe(false);
    expect(GITHUB_SLUG_RE.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex credential step (#92)
// ---------------------------------------------------------------------------

describe("runInit Codex step", () => {
  // Invented values only.
  const OPENAI_KEY = "sk-proj-INVENTED-integration-key-00000000";
  const planAuth = { auth_mode: "chatgpt", tokens: { access_token: "eyINVENTED", refresh_token: "rt_INVENTED_integration", account_id: "acct" } };
  const readEnvFile = () => parseEnv(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8"));
  const authFile = () => {
    const f = path.join(tmpDir + "-codex", "auth.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(planAuth, null, 2));
    return f;
  };

  beforeEach(() => {
    onPathMock.mockReset();
    onPathMock.mockReturnValue(false);
    vi.mocked(promptSecret).mockClear();
    vi.mocked(summaryBox).mockClear();
  });
  afterEach(() => {
    fs.rmSync(tmpDir + "-codex", { recursive: true, force: true });
    delete process.env.S137_TEST_OPENAI_KEY;
  });

  it("parses the Codex flags, including --flag=value", () => {
    const o = parseArgs(["node", "cli", "init", "--codex-auth-file=/a/auth.json", "--yes"]);
    expect(o.codexAuthFile).toBe("/a/auth.json");
    expect(parseArgs(["node", "cli", "init", "--openai-api-key-env", "MY_KEY"]).openaiApiKeyEnv).toBe("MY_KEY");
    expect(parseArgs(["node", "cli", "init", "--skip-codex"]).skipCodex).toBe(true);
    expect(parseArgs(["node", "cli", "codex", "--openai-api-key-env", "MY_KEY"]).command).toBe("codex");
  });

  it("refuses two Codex sources at once", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    expect(() => parseArgs(["node", "cli", "init", "--codex-auth-file", "/a", "--openai-api-key-env", "K"])).toThrow("exit 1");
    expect(() => parseArgs(["node", "cli", "init", "--skip-codex", "--codex-auth-file", "/a"])).toThrow("exit 1");
    exit.mockRestore();
  });

  it("--codex-auth-file writes CODEX_AUTH_JSON as one line to the 0600 .env, and nothing else", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, codexAuthFile: authFile() });
    const raw = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    const line = raw.split("\n").find((l) => l.startsWith(`${ENV_KEYS.CODEX_AUTH_JSON}=`));
    expect(line).toBeDefined();
    expect(JSON.parse(readEnvFile()[ENV_KEYS.CODEX_AUTH_JSON]!)).toEqual(planAuth);
    expect(readEnvFile()[ENV_KEYS.OPENAI_API_KEY]).toBeUndefined();
    expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("--openai-api-key-env writes OPENAI_API_KEY when the compose file forwards it", async () => {
    process.env.S137_TEST_OPENAI_KEY = OPENAI_KEY;
    seedCompose(tmpDir, composeWithOpenAIKey());
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, openaiApiKeyEnv: "S137_TEST_OPENAI_KEY" });
    const env = readEnvFile();
    expect(env[ENV_KEYS.OPENAI_API_KEY]).toBe(OPENAI_KEY);
    expect(env[ENV_KEYS.CODEX_AUTH_JSON]).toBeUndefined();
    expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("--openai-api-key-env with a compose file that does not forward it stores nothing", async () => {
    process.env.S137_TEST_OPENAI_KEY = OPENAI_KEY;
    seedCompose(tmpDir, composeWithoutOpenAIKey());
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, openaiApiKeyEnv: "S137_TEST_OPENAI_KEY" });
    const env = readEnvFile();
    expect(env[ENV_KEYS.OPENAI_API_KEY]).toBeUndefined();
    expect(env[ENV_KEYS.CODEX_AUTH_JSON]).toBeUndefined();
  });

  it("--skip-docker still reports the Codex outcome", async () => {
    vi.mocked(info).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, codexAuthFile: authFile() });
    expect(vi.mocked(info).mock.calls.map((c) => String(c[0]))).toContain("Codex enabled (Codex auth.json).");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(info).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    expect(vi.mocked(info).mock.calls.map((c) => String(c[0]))).toContain("Codex skipped. Add it later: npx @syntropic137/setup codex");
  });

  it("reconfiguring an install whose .env is 0644 leaves it 0600", async () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=true\n", { mode: 0o644 });
    fs.chmodSync(path.join(tmpDir, ".env"), 0o644);
    vi.mocked(confirm).mockResolvedValue(true);
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, codexAuthFile: authFile() }));
    expect(readEnvFile()[ENV_KEYS.CODEX_AUTH_JSON]).toBeDefined();
    expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("without a terminal or a flag (even with --yes), writes no Codex credential", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true, yes: true });
    const env = readEnvFile();
    expect(env[ENV_KEYS.CODEX_AUTH_JSON]).toBeUndefined();
    expect(env[ENV_KEYS.OPENAI_API_KEY]).toBeUndefined();
  });

  it("in a terminal, asks after the Anthropic credential and stores a pasted key", async () => {
    onPathMock.mockReturnValue(true);
    seedCompose(tmpDir, composeWithOpenAIKey());
    vi.mocked(promptSecret)
      .mockResolvedValueOnce("sk-ant-test-key-123")
      .mockResolvedValueOnce(OPENAI_KEY);
    vi.mocked(confirm).mockClear();
    await withTerminal(() => runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true }));
    const prompts = vi.mocked(promptSecret).mock.calls.map((c) => String(c[0]));
    expect(prompts).toEqual(["Anthropic credential", "Codex credential"]);
    expect(vi.mocked(confirm).mock.calls.find((c) => c[0] === "Enable Codex phases?")?.[1]).toBe(true);
    const env = readEnvFile();
    expect(env[ENV_KEYS.ANTHROPIC_API_KEY]).toBe("sk-ant-test-key-123");
    expect(env[ENV_KEYS.OPENAI_API_KEY]).toBe(OPENAI_KEY);
  });

  it("the summary says which Codex credential, or that it was skipped", async () => {
    await runInit({ command: "init", dir: tmpDir, skipGithub: true, codexAuthFile: authFile() });
    expect(vi.mocked(summaryBox).mock.calls[0]![0].codex).toEqual({ enabled: true, kind: "auth-json" });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.mocked(summaryBox).mockClear();
    await runInit({ command: "init", dir: tmpDir, skipGithub: true });
    expect(vi.mocked(summaryBox).mock.calls[0]![0].codex).toEqual({ enabled: false });
  });
});

describe("codex command (add or replace later)", () => {
  const KEY = "sk-proj-INVENTED-command-key-000000000000";
  afterEach(() => {
    delete process.env.S137_TEST_OPENAI_KEY;
    process.exitCode = undefined;
  });

  it("replaces CODEX_AUTH_JSON with OPENAI_API_KEY, keeps the rest, tightens a 0644 .env to 0600", async () => {
    seedCompose(tmpDir, composeWithOpenAIKey());
    process.env.CODEX_AUTH_JSON = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt_INVENTED_cmd" } });
    try {
      await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    } finally {
      delete process.env.CODEX_AUTH_JSON;
    }
    const before = parseEnv(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8"));
    expect(before[ENV_KEYS.CODEX_AUTH_JSON]).toBeDefined();

    fs.chmodSync(path.join(tmpDir, ".env"), 0o644);

    process.env.S137_TEST_OPENAI_KEY = KEY;
    await new CLI(["node", "cli", "codex", "--dir", tmpDir, "--openai-api-key-env", "S137_TEST_OPENAI_KEY"]).run();

    const after = parseEnv(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8"));
    expect(after[ENV_KEYS.OPENAI_API_KEY]).toBe(KEY);
    expect(after[ENV_KEYS.CODEX_AUTH_JSON]).toBeUndefined();
    expect(after[ENV_KEYS.SYN_API_PASSWORD]).toBe(before[ENV_KEYS.SYN_API_PASSWORD]);
    expect(fs.statSync(path.join(tmpDir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("refuses --skip-codex and leaves .env untouched, even with CODEX_AUTH_JSON exported", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    const before = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    process.env.CODEX_AUTH_JSON = JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt_INVENTED_skip" } });
    try {
      await expect((async () => new CLI(["node", "cli", "codex", "--dir", tmpDir, "--skip-codex"]).run())()).rejects.toThrow("exit 1");
    } finally {
      delete process.env.CODEX_AUTH_JSON;
      exit.mockRestore();
    }
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8")).toBe(before);
  });

  it("without a terminal or a flag, changes nothing and exits non-zero", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });
    const before = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    await new CLI(["node", "cli", "codex", "--dir", tmpDir]).run();
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, ".env"), "utf-8")).toBe(before);
  });
});
