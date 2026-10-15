import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { writeEnvFile, readEnvFile, envExists } from "./config.js";

// Mock UI to silence output
vi.mock("./ui.js", () => ({
  success: vi.fn(),
}));

let tmpDir: string;
let templateDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `s137-config-test-${crypto.randomUUID()}`);
  templateDir = path.join(tmpDir, "templates");
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(templateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemplate(content: string): void {
  fs.writeFileSync(path.join(templateDir, "selfhost.env.example"), content);
}

describe("writeEnvFile", () => {
  it("leaves .env 0600 even when it already existed with a looser mode", () => {
    writeTemplate("APP_ENVIRONMENT=\n");
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "OLD=1\n", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);
    writeEnvFile(tmpDir, { APP_ENVIRONMENT: "selfhost", SYN_VERSION: "x", OPENAI_API_KEY: "sk-proj-INVENTED-0000000000000000" }, templateDir);
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("keeps `$` sequences in values literal", () => {
    writeTemplate("SYN_API_PASSWORD=\nAPP_ENVIRONMENT=\n");
    const password = "invented$&pa$1ss$$word$`x$'y";
    writeEnvFile(tmpDir, { SYN_API_PASSWORD: password, APP_ENVIRONMENT: "selfhost", SYN_VERSION: "x" }, templateDir);
    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain(`SYN_API_PASSWORD=${password}\n`);
  });

  it("substitutes values in template", () => {
    writeTemplate("APP_ENVIRONMENT=\nSYN_VERSION=latest\n");
    writeEnvFile(tmpDir, { APP_ENVIRONMENT: "selfhost", SYN_VERSION: "v0.18.0" }, templateDir);

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("APP_ENVIRONMENT=selfhost");
    expect(content).toContain("SYN_VERSION=v0.18.0");
  });

  it("sets file mode to 0o600", () => {
    writeTemplate("APP_ENVIRONMENT=\n");
    writeEnvFile(tmpDir, { APP_ENVIRONMENT: "selfhost", SYN_VERSION: "latest" }, templateDir);

    const stat = fs.statSync(path.join(tmpDir, ".env"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("appends keys not in template", () => {
    writeTemplate("APP_ENVIRONMENT=\n");
    writeEnvFile(
      tmpDir,
      { APP_ENVIRONMENT: "selfhost", SYN_VERSION: "latest", CUSTOM_KEY: "custom_value" },
      templateDir,
    );

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("CUSTOM_KEY=custom_value");
  });

  it("skips undefined and empty values", () => {
    writeTemplate("APP_ENVIRONMENT=original\nANTHROPIC_API_KEY=keep-this\n");
    writeEnvFile(
      tmpDir,
      { APP_ENVIRONMENT: "selfhost", SYN_VERSION: "latest", ANTHROPIC_API_KEY: undefined },
      templateDir,
    );

    const content = fs.readFileSync(path.join(tmpDir, ".env"), "utf-8");
    expect(content).toContain("ANTHROPIC_API_KEY=keep-this");
  });
});

describe("readEnvFile", () => {
  it("parses key=value pairs", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "A=1\nB=hello\n");

    expect(readEnvFile(envPath)).toEqual({ A: "1", B: "hello" });
  });

  it("skips comments and blank lines", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "# comment\n\nA=1\n  \n# another comment\nB=2\n");

    expect(readEnvFile(envPath)).toEqual({ A: "1", B: "2" });
  });

  it("returns {} for nonexistent file", () => {
    expect(readEnvFile(path.join(tmpDir, "does-not-exist"))).toEqual({});
  });

  it("handles values containing =", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "DSN=postgres://u:p@h/db?a=1&b=2\n");

    expect(readEnvFile(envPath)).toEqual({ DSN: "postgres://u:p@h/db?a=1&b=2" });
  });
});

describe("envExists", () => {
  it("returns true when .env is present", () => {
    fs.writeFileSync(path.join(tmpDir, ".env"), "X=1");
    expect(envExists(tmpDir)).toBe(true);
  });

  it("returns false when .env is absent", () => {
    expect(envExists(tmpDir)).toBe(false);
  });
});
