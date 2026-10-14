import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { generateSecrets, savePem, saveWebhookSecret, saveClientSecret, normalizeSecretPermissions, writeMountedSecret, MOUNTED_SECRET_FILES } from "./secrets.js";

// Mock UI to silence output
vi.mock("./ui.js", () => ({
  success: vi.fn(),
  info: vi.fn(),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = path.join(os.tmpdir(), `s137-secrets-test-${crypto.randomUUID()}`);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("generateSecrets", () => {
  it("creates all three secret files", () => {
    generateSecrets(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, "db-password.secret"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "redis-password.secret"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "minio-password.secret"))).toBe(true);
  });

  it("files contain 64-char hex strings", () => {
    generateSecrets(tmpDir);

    for (const name of ["db-password.secret", "redis-password.secret", "minio-password.secret"]) {
      const content = fs.readFileSync(path.join(tmpDir, name), "utf-8");
      expect(content).toHaveLength(64);
      expect(content).toMatch(/^[0-9a-f]+$/);
    }
  });

  it("container-read secrets are 0644 inside a 0700 directory (issue #78: minio runs as 999)", () => {
    generateSecrets(tmpDir);

    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);
    for (const name of ["db-password.secret", "redis-password.secret", "minio-password.secret", "github-app-private-key.pem"]) {
      const stat = fs.statSync(path.join(tmpDir, name));
      expect(stat.mode & 0o777).toBe(0o644);
    }
  });

  it("force regeneration relaxes a file an older setup wrote 0600", () => {
    const existing = path.join(tmpDir, "minio-password.secret");
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(existing, "old", { mode: 0o600 });
    generateSecrets(tmpDir, true);
    expect(fs.statSync(existing).mode & 0o777).toBe(0o644);
  });

  it("does not overwrite existing files by default", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const existing = path.join(tmpDir, "db-password.secret");
    fs.writeFileSync(existing, "keep-this-value");

    generateSecrets(tmpDir);

    expect(fs.readFileSync(existing, "utf-8")).toBe("keep-this-value");
  });

  it("regenerates and backs up existing files when force=true", () => {
    fs.mkdirSync(tmpDir, { recursive: true });
    const existing = path.join(tmpDir, "db-password.secret");
    fs.writeFileSync(existing, "old-secret-value", { mode: 0o600 });

    generateSecrets(tmpDir, true);

    // Old secret backed up
    const bakPath = path.join(tmpDir, "db-password.secret.bak");
    expect(fs.existsSync(bakPath)).toBe(true);
    expect(fs.readFileSync(bakPath, "utf-8")).toBe("old-secret-value");
    expect(fs.statSync(bakPath).mode & 0o777).toBe(0o600);

    // New secret generated (different from old)
    const newSecret = fs.readFileSync(existing, "utf-8");
    expect(newSecret).not.toBe("old-secret-value");
    expect(newSecret).toHaveLength(64);
    expect(newSecret).toMatch(/^[0-9a-f]+$/);
  });

  it("creates empty PEM placeholder", () => {
    generateSecrets(tmpDir);

    const pemPath = path.join(tmpDir, "github-app-private-key.pem");
    expect(fs.existsSync(pemPath)).toBe(true);
    expect(fs.readFileSync(pemPath, "utf-8")).toBe("");
  });

  it("creates secrets dir if it does not exist", () => {
    const nested = path.join(tmpDir, "deep", "secrets");
    generateSecrets(nested);

    expect(fs.existsSync(nested)).toBe(true);
    expect(fs.existsSync(path.join(nested, "db-password.secret"))).toBe(true);
  });
});

describe("savePem", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("writes PEM content and returns path", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----";
    const result = savePem(tmpDir, pem);

    expect(result).toBe(path.join(tmpDir, "github-app-private-key.pem"));
    expect(fs.readFileSync(result, "utf-8")).toBe(pem);
  });

  it("is readable by the api container (0644)", () => {
    savePem(tmpDir, "test");
    const stat = fs.statSync(path.join(tmpDir, "github-app-private-key.pem"));
    expect(stat.mode & 0o777).toBe(0o644);
  });
});

describe("saveWebhookSecret", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("writes to github-webhook-secret.txt", () => {
    saveWebhookSecret(tmpDir, "wh-secret-123");
    const content = fs.readFileSync(path.join(tmpDir, "github-webhook-secret.txt"), "utf-8");
    expect(content).toBe("wh-secret-123");
  });
});

describe("saveClientSecret", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it("writes to github-client-secret.txt", () => {
    saveClientSecret(tmpDir, "client-secret-456");
    const content = fs.readFileSync(path.join(tmpDir, "github-client-secret.txt"), "utf-8");
    expect(content).toBe("client-secret-456");
  });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe("secret permission invariant (#78, Codex review of #79)", () => {
  /** An install written by 1.0.1 or older: every mounted file 0600, dir 0755. */
  function legacyInstall(): void {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.chmodSync(tmpDir, 0o755);
    for (const f of MOUNTED_SECRET_FILES) fs.writeFileSync(path.join(tmpDir, f), `old-${f}`, { mode: 0o600 });
  }

  it("normalizes a legacy 0600 install without touching contents", () => {
    legacyInstall();
    normalizeSecretPermissions(tmpDir);
    expect(mode(tmpDir)).toBe(0o700);
    for (const f of MOUNTED_SECRET_FILES) {
      expect(mode(path.join(tmpDir, f)), f).toBe(0o644);
      expect(fs.readFileSync(path.join(tmpDir, f), "utf-8")).toBe(`old-${f}`);
    }
  });

  it("generate() fixes modes of files it keeps", () => {
    legacyInstall();
    generateSecrets(tmpDir);
    for (const f of MOUNTED_SECRET_FILES) expect(mode(path.join(tmpDir, f)), f).toBe(0o644);
    expect(mode(tmpDir)).toBe(0o700);
  });

  it("the PEM placeholder is 0644 even under umask 077", () => {
    const prev = process.umask(0o077);
    try {
      generateSecrets(tmpDir);
    } finally {
      process.umask(prev);
    }
    for (const f of MOUNTED_SECRET_FILES) expect(mode(path.join(tmpDir, f)), f).toBe(0o644);
  });

  it("is a no-op when the secrets dir does not exist", () => {
    expect(() => normalizeSecretPermissions(path.join(tmpDir, "absent"))).not.toThrow();
  });

  it("rotation's writer leaves an overwritten legacy 0600 file readable, and re-secures the dir", () => {
    legacyInstall();
    const f = MOUNTED_SECRET_FILES[0]!;
    writeMountedSecret(tmpDir, f, "new-value");
    expect(fs.readFileSync(path.join(tmpDir, f), "utf-8")).toBe("new-value");
    expect(mode(path.join(tmpDir, f))).toBe(0o644);
    expect(mode(tmpDir)).toBe(0o700);
  });
});
