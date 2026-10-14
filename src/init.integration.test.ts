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
const { skillsInstall } = vi.hoisted(() => ({ skillsInstall: vi.fn() }));
vi.mock("./skills.js", () => ({
  defaultRunner: vi.fn(),
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

import { parseArgs, runInit } from "./cli.js";
import { confirm } from "./ui.js";
import { GITHUB_SLUG_RE } from "./constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `s137-init-test-${crypto.randomUUID()}`);
});

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

describe("runInit with mocked GitHub flow", () => {
  it("writes app ID and slug to .env", async () => {
    await runInit({ command: "init", dir: tmpDir, skipDocker: true });

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("SYN_GITHUB_APP_ID=42");
    expect(content).toContain("SYN_GITHUB_APP_NAME=test-syntropic137");
  });
});

describe("runInit re-run safety", () => {
  it("detects existing .env and respects decline to reconfigure", async () => {
    // Pre-create install dir with .env
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".env"), "EXISTING=true");

    // Mock confirm to return false (decline reconfigure)
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await runInit({ command: "init", dir: tmpDir, skipDocker: true, skipGithub: true });

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
