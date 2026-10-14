import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { parseArgs, runInit } from "./cli.js";
import { ConfigManager } from "./config.js";
import { ENV_KEYS } from "./constants.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("./ui.js", () => ({
  banner: vi.fn(),
  setupOverview: vi.fn(),
  summaryBox: vi.fn(),
  step: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  fail: vi.fn(),
  warn: vi.fn(),
  bold: (s: string) => s,
  dim: (s: string) => s,
  cyan: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  prompt: vi.fn().mockResolvedValue(""),
  promptSecret: vi.fn().mockResolvedValue(""),
  confirm: vi.fn().mockResolvedValue(false),
  interactiveMenu: vi.fn().mockResolvedValue("show"),
  setTotalSteps: vi.fn(),
}));

vi.mock("./docker.js", () => ({
  checkDocker: vi.fn(),
  DockerService: vi.fn().mockImplementation(() => ({
    pull: vi.fn(),
    up: vi.fn(),
    stop: vi.fn(),
    start: vi.fn(),
    status: vi.fn(),
    logs: vi.fn(),
    update: vi.fn(),
    downWithVolumes: vi.fn(),
    waitForHealth: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("./manifest.js", () => ({
  GitHubAppSetup: vi.fn(),
  openBrowser: vi.fn(),
}));

// Agent skills: never run npx against the real machine from a test
vi.mock("./skills.js", () => ({
  defaultRunner: vi.fn(),
  SkillsManager: vi.fn().mockImplementation(() => ({
    install: vi.fn().mockResolvedValue("installed"),
    status: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn().mockReturnValue(Buffer.from("")),
  execSync: vi.fn().mockReturnValue(Buffer.from("")),
}));

// templates.js: use actual TEMPLATES_DIR (so writeEnv can read selfhost.env.example)
// but make syncTemplate create empty destination files rather than doing a real copy,
// so tests don't depend on the full package layout being present.
vi.mock("./templates.js", async () => {
  const actual = await vi.importActual<typeof import("./templates.js")>("./templates.js");
  return {
    ...actual,
    syncTemplate: vi.fn().mockImplementation(
      (_tplDir: string, installDir: string, relativePath: string) => {
        const dest = path.join(installDir, relativePath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (!fs.existsSync(dest)) fs.writeFileSync(dest, "");
      },
    ),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `s137-cred-test-${crypto.randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readEnv(dir: string): Record<string, string> {
  const content = fs.readFileSync(path.join(dir, ".env"), "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return result;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  vi.clearAllMocks();
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ENV_KEYS — single source of truth, no magic strings
// ---------------------------------------------------------------------------

describe("ENV_KEYS constant", () => {
  it("key name matches key value — no typos or aliasing", () => {
    for (const [key, value] of Object.entries(ENV_KEYS)) {
      expect(key).toBe(value);
    }
  });

  it("defines SYN_API_PASSWORD", () => {
    expect(ENV_KEYS.SYN_API_PASSWORD).toBe("SYN_API_PASSWORD");
  });

  it("defines SYN_API_USER", () => {
    expect(ENV_KEYS.SYN_API_USER).toBe("SYN_API_USER");
  });

  it("all values are non-empty strings", () => {
    for (const value of Object.values(ENV_KEYS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("no duplicate values across keys", () => {
    const values = Object.values(ENV_KEYS);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — credentials command parsing
// ---------------------------------------------------------------------------

describe("parseArgs — credentials command", () => {
  it("recognizes 'credentials' without action", () => {
    const opts = parseArgs(["node", "cli", "credentials"]);
    expect(opts.command).toBe("credentials");
    expect(opts.credentialsAction).toBeUndefined();
  });

  it("parses 'credentials show'", () => {
    const opts = parseArgs(["node", "cli", "credentials", "show"]);
    expect(opts.command).toBe("credentials");
    expect(opts.credentialsAction).toBe("show");
  });

  it("parses 'credentials rotate'", () => {
    const opts = parseArgs(["node", "cli", "credentials", "rotate"]);
    expect(opts.command).toBe("credentials");
    expect(opts.credentialsAction).toBe("rotate");
  });

  it("ignores unrecognised sub-action — leaves credentialsAction undefined", () => {
    const opts = parseArgs(["node", "cli", "credentials", "nope"]);
    expect(opts.command).toBe("credentials");
    expect(opts.credentialsAction).toBeUndefined();
  });

  it("respects --dir flag alongside credentials show", () => {
    const opts = parseArgs([
      "node", "cli", "credentials", "show", "--dir", "/some/path",
    ]);
    expect(opts.command).toBe("credentials");
    expect(opts.credentialsAction).toBe("show");
    expect(opts.dir).toBe("/some/path");
  });
});

// ---------------------------------------------------------------------------
// ConfigManager.writeEnv — empty-string skip is the security gate
// ---------------------------------------------------------------------------

describe("ConfigManager.writeEnv — empty-string skip", () => {
  function makeTemplateDir(content: string): string {
    const tplDir = path.join(tmpDir, "templates");
    fs.mkdirSync(tplDir, { recursive: true });
    fs.writeFileSync(path.join(tplDir, "selfhost.env.example"), content);
    return tplDir;
  }

  it("does NOT write empty-string values to .env", () => {
    const tplDir = makeTemplateDir("SYN_API_PASSWORD=\nAPP_ENVIRONMENT=\n");
    const config = new ConfigManager(tmpDir);

    config.writeEnv(
      { APP_ENVIRONMENT: "selfhost", SYN_API_PASSWORD: "" } as never,
      tplDir,
    );

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    // Empty string skipped — template placeholder stays empty
    expect(content).toMatch(/^SYN_API_PASSWORD=\s*$/m);
    expect(content).toContain("APP_ENVIRONMENT=selfhost");
  });

  it("does NOT write undefined values to .env", () => {
    const tplDir = makeTemplateDir("SYN_API_PASSWORD=existing\nAPP_ENVIRONMENT=\n");
    const config = new ConfigManager(tmpDir);

    config.writeEnv(
      { APP_ENVIRONMENT: "selfhost", SYN_API_PASSWORD: undefined },
      tplDir,
    );

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    // Undefined skipped — original template value preserved
    expect(content).toContain("SYN_API_PASSWORD=existing");
  });

  it("writes a non-empty SYN_API_PASSWORD", () => {
    const tplDir = makeTemplateDir("SYN_API_PASSWORD=\nAPP_ENVIRONMENT=\n");
    const config = new ConfigManager(tmpDir);
    const password = crypto.randomBytes(32).toString("hex");

    config.writeEnv(
      { APP_ENVIRONMENT: "selfhost", SYN_API_PASSWORD: password },
      tplDir,
    );

    const env = readEnv(tmpDir);
    expect(env[ENV_KEYS.SYN_API_PASSWORD]).toBe(password);
  });

  it("does NOT append empty-string keys that are missing from template", () => {
    const tplDir = makeTemplateDir("APP_ENVIRONMENT=\n");
    const config = new ConfigManager(tmpDir);

    config.writeEnv(
      { APP_ENVIRONMENT: "selfhost", SYN_API_PASSWORD: "" } as never,
      tplDir,
    );

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).not.toContain("SYN_API_PASSWORD");
  });
});

// ---------------------------------------------------------------------------
// Tunnel security gate — blocks activation without password
// ---------------------------------------------------------------------------

describe("tunnel security gate", () => {
  function writeEnvFile(dir: string, content: string): void {
    fs.writeFileSync(path.join(dir, ".env"), content, { mode: 0o600 });
  }

  function trapExit(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  }

  it("blocks when SYN_API_PASSWORD is absent from .env", async () => {
    writeEnvFile(tmpDir, "APP_ENVIRONMENT=selfhost\n");

    const { CLI } = await import("./cli.js");
    const cli = new CLI(["node", "cli", "tunnel", "--dir", tmpDir]);
    const exitSpy = trapExit();

    await expect(cli.run()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("blocks when SYN_API_PASSWORD is empty string", async () => {
    writeEnvFile(tmpDir, `APP_ENVIRONMENT=selfhost\n${ENV_KEYS.SYN_API_PASSWORD}=\n`);

    const { CLI } = await import("./cli.js");
    const cli = new CLI(["node", "cli", "tunnel", "--dir", tmpDir]);
    const exitSpy = trapExit();

    await expect(cli.run()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("blocks when SYN_API_PASSWORD is whitespace only", async () => {
    writeEnvFile(tmpDir, `APP_ENVIRONMENT=selfhost\n${ENV_KEYS.SYN_API_PASSWORD}=   \n`);

    const { CLI } = await import("./cli.js");
    const cli = new CLI(["node", "cli", "tunnel", "--dir", tmpDir]);
    const exitSpy = trapExit();

    await expect(cli.run()).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// InitFlow — auto-generates SYN_API_PASSWORD
// ---------------------------------------------------------------------------

describe("InitFlow — SYN_API_PASSWORD auto-generation", () => {
  it("writes a 64-char hex password to .env", async () => {
    await runInit({
      command: "init",
      dir: tmpDir,
      skipDocker: true,
      skipGithub: true,
    });

    const env = readEnv(tmpDir);
    const password = env[ENV_KEYS.SYN_API_PASSWORD];

    expect(password).toBeDefined();
    expect(password).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes SYN_API_USER=admin by default", async () => {
    await runInit({
      command: "init",
      dir: tmpDir,
      skipDocker: true,
      skipGithub: true,
    });

    const env = readEnv(tmpDir);
    expect(env[ENV_KEYS.SYN_API_USER]).toBe("admin");
  });

  it("generates a unique password each run", async () => {
    const dir2 = makeTmpDir();

    try {
      await runInit({ command: "init", dir: tmpDir,  skipDocker: true, skipGithub: true });
      await runInit({ command: "init", dir: dir2,    skipDocker: true, skipGithub: true });

      const pass1 = readEnv(tmpDir)[ENV_KEYS.SYN_API_PASSWORD];
      const pass2 = readEnv(dir2)[ENV_KEYS.SYN_API_PASSWORD];

      expect(pass1).toBeDefined();
      expect(pass2).toBeDefined();
      expect(pass1).not.toBe(pass2);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("password is never empty string", async () => {
    await runInit({
      command: "init",
      dir: tmpDir,
      skipDocker: true,
      skipGithub: true,
    });

    const env = readEnv(tmpDir);
    expect(env[ENV_KEYS.SYN_API_PASSWORD]).not.toBe("");
    expect(env[ENV_KEYS.SYN_API_PASSWORD]).not.toBeUndefined();
  });
});
