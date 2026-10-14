import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

vi.mock("./ui.js", () => ({
  bold: (s: string) => s,
  dim: (s: string) => s,
  cyan: (s: string) => s,
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
}));

import {
  ResetRefusal,
  assertResettableDir,
  backupDirFor,
  describePlan,
  executeReset,
  githubAppSettingsUrl,
  parseComposeProjectName,
  parseNpmGlobalVersion,
  parseSyntropicImages,
  planReset,
  printPlan,
  type ResetOptions,
  type ResetProbe,
  type SyncRunner,
} from "./reset.js";
import { COMPOSE_FILE, SELFHOST_COMPOSE_PROJECT } from "./constants.js";
import type { CommandResult } from "./skills.js";
import { info } from "./ui.js";

const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
const bad = (stderr = "boom"): CommandResult => ({ ok: false, stdout: "", stderr, error: "exit 1" });

interface Call { cmd: string; args: readonly string[] }

const LABEL = `label=com.docker.compose.project=${SELFHOST_COMPOSE_PROJECT}`;
const IMAGES = [
  "ghcr.io/syntropic137/syn-api\tv1.0.0\tsha256:aaa\tid1",
  "ghcr.io/syntropic137/syn-gateway\t<none>\tsha256:bbb\tid2",
  "ghcr.io/syntropic137/agentic-workspace/claude\tlatest\t<none>\tid3",
  "ghcr.io/someone-else/thing\tlatest\t<none>\tid4",
  "redis\t7-alpine\t<none>\tid5",
].join("\n");

function fakeDocker(o: { docker?: boolean; containers?: string[]; volumes?: string[]; networks?: string[]; cliJson?: string } = {}) {
  const calls: Call[] = [];
  const run: SyncRunner = (cmd, args) => {
    calls.push({ cmd, args });
    const a = args.join(" ");
    if (cmd === "docker" && a === "info") return o.docker === false ? bad("daemon down") : ok();
    if (cmd === "docker" && a.startsWith("ps -a") && args.includes(LABEL)) return ok((o.containers ?? []).join("\n"));
    if (cmd === "docker" && a.startsWith("volume ls") && args.includes(LABEL)) return ok((o.volumes ?? []).join("\n"));
    if (cmd === "docker" && a.startsWith("network ls") && args.includes(LABEL)) return ok((o.networks ?? []).join("\n"));
    if (cmd === "docker" && a.startsWith("image ls")) return ok(IMAGES);
    if (cmd === "npm" && args[0] === "ls") return ok(o.cliJson ?? "{}");
    return ok();
  };
  return { run, calls };
}

let root: string;
let home: string;
let installDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = path.join(os.tmpdir(), `s137-reset-${crypto.randomUUID()}`);
  home = path.join(root, "home");
  installDir = path.join(home, ".syntropic137");
  fs.mkdirSync(path.join(installDir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(installDir, COMPOSE_FILE), `services: {}\nname: ${SELFHOST_COMPOSE_PROJECT}\n`);
  fs.writeFileSync(path.join(installDir, ".env"), "SYN_GITHUB_APP_NAME=my-app\nSYN_GITHUB_APP_ORG=acme\n");
  fs.writeFileSync(path.join(installDir, "secrets", "db-password.secret"), "x");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 14, 9, 5, 7);
const opts = (o: Partial<ResetOptions> = {}): ResetOptions => ({
  installDir,
  backup: true,
  images: false,
  cli: false,
  skills: false,
  ...o,
});
const probe = (run: SyncRunner, skills: string[] | null = ["syn-workflow"]): ResetProbe => ({
  run,
  listSkills: async () => skills,
  homedir: home,
  now: NOW,
});

describe("scope refusals", () => {
  it("refuses the filesystem root", () => {
    expect(() => assertResettableDir("/", home, true, [COMPOSE_FILE])).toThrow(ResetRefusal);
  });

  it("refuses the home directory and its parents", () => {
    expect(() => assertResettableDir(home, home, true, [COMPOSE_FILE, ".env"])).toThrow(/home directory/);
    expect(() => assertResettableDir(root, home, true, [COMPOSE_FILE])).toThrow(/home directory/);
  });

  it("refuses an existing dir that is not an install", () => {
    expect(() => assertResettableDir(installDir, home, true, ["notes.txt"])).toThrow(/does not look like/);
  });

  it("accepts an install dir, and a missing one", () => {
    expect(() => assertResettableDir(installDir, home, true, [COMPOSE_FILE])).not.toThrow();
    expect(() => assertResettableDir(installDir, home, true, [".env"])).not.toThrow();
    expect(() => assertResettableDir(installDir, home, false, [])).not.toThrow();
  });

  it("refuses an install whose compose file names another project", async () => {
    fs.writeFileSync(path.join(installDir, COMPOSE_FILE), "name: someone_elses_stack\nservices: {}\n");
    const { run, calls } = fakeDocker();
    await expect(planReset(opts(), probe(run))).rejects.toThrow(/someone_elses_stack/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a file in place of the install dir", async () => {
    const file = path.join(home, "file");
    fs.writeFileSync(file, "x");
    await expect(planReset(opts({ installDir: file }), probe(fakeDocker().run))).rejects.toThrow(/not a directory/);
  });
});

describe("target selection", () => {
  it("selects only the selfhost compose project's resources", async () => {
    const { run, calls } = fakeDocker({ containers: ["syn137-api"], volumes: ["syntropic137_selfhost_pg"], networks: ["syntropic137_selfhost_default"] });
    const plan = await planReset(opts(), probe(run));
    expect(plan.compose).toMatchObject({
      project: SELFHOST_COMPOSE_PROJECT,
      containers: ["syn137-api"],
      volumes: ["syntropic137_selfhost_pg"],
      networks: ["syntropic137_selfhost_default"],
    });
    const listing = calls.filter((c) => c.cmd === "docker" && c.args[0] !== "info");
    expect(listing.every((c) => c.args.includes(LABEL))).toBe(true);
  });

  it("does not look at images, CLI or skills unless asked", async () => {
    const { run, calls } = fakeDocker();
    const plan = await planReset(opts(), probe(run));
    expect(plan.images).toBeNull();
    expect(plan.cli).toBeNull();
    expect(plan.skills).toBeNull();
    expect(calls.some((c) => c.args[0] === "image" || c.cmd === "npm")).toBe(false);
  });

  it("selects only ghcr.io/syntropic137 images with --images", async () => {
    const plan = await planReset(opts({ images: true }), probe(fakeDocker().run));
    expect(plan.images).toEqual([
      "ghcr.io/syntropic137/agentic-workspace/claude:latest",
      "ghcr.io/syntropic137/syn-api:v1.0.0",
      "ghcr.io/syntropic137/syn-gateway@sha256:bbb",
    ]);
  });

  it("finds the CLI and skills when asked", async () => {
    const cliJson = JSON.stringify({ dependencies: { "@syntropic137/cli": { version: "1.0.0" } } });
    const plan = await planReset(opts({ cli: true, skills: true }), probe(fakeDocker({ cliJson }).run));
    expect(plan.cli).toBe("1.0.0");
    expect(plan.skills).toEqual(["syn-workflow"]);
  });

  it("backs up to a timestamped sibling by default, deletes with --no-backup", async () => {
    const withBackup = await planReset(opts(), probe(fakeDocker().run));
    expect(withBackup.backupDir).toBe(`${installDir}.backup-20261014-090507`);
    const noBackup = await planReset(opts({ backup: false }), probe(fakeDocker().run));
    expect(noBackup.backupDir).toBeNull();
  });

  it("notes when Docker is unavailable instead of failing", async () => {
    const plan = await planReset(opts({ images: true }), probe(fakeDocker({ docker: false }).run));
    expect(plan.compose).toBeNull();
    expect(plan.images).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/Docker is not running/);
  });

  it("reads the GitHub App from .env for the note", async () => {
    const plan = await planReset(opts(), probe(fakeDocker().run));
    expect(plan.githubApp).toEqual({ slug: "my-app", org: "acme" });
    expect(githubAppSettingsUrl(plan.githubApp!)).toBe("https://github.com/organizations/acme/settings/apps/my-app/advanced");
  });
});

describe("dry-run output", () => {
  it("lists exactly what would be removed and removes nothing", async () => {
    const { run, calls } = fakeDocker({ containers: ["syn137-api"], volumes: ["v1"] });
    const plan = await planReset(opts({ images: true }), probe(run));
    printPlan(plan, false);
    const out = vi.mocked(info).mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Would remove:");
    expect(out).toContain("Not selected: syn CLI (--cli), agent skills (--skills)");

    const groups = describePlan(plan);
    expect(groups.map((g) => g.section)).toEqual([
      `Docker compose project "${SELFHOST_COMPOSE_PROJECT}" (docker compose down -v)`,
      "Images (ghcr.io/syntropic137/*)",
      "Install directory",
    ]);
    expect(groups[0]!.items).toEqual(["container syn137-api", "volume v1"]);
    expect(groups[2]!.items[0]).toContain(".backup-20261014-090507");

    // Planning ran only read-only commands and left the install in place.
    const mutating = calls.filter((c) => ["down", "rm", "uninstall"].some((v) => c.args.includes(v)));
    expect(mutating).toHaveLength(0);
    expect(fs.existsSync(installDir)).toBe(true);
  });
});

describe("executeReset", () => {
  it("runs compose down with the project and file, then backs up with chmod 700", async () => {
    const { run, calls } = fakeDocker({ containers: ["syn137-api"], volumes: ["v1"] });
    const plan = await planReset(opts(), probe(run));
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results.every((r) => r.ok)).toBe(true);

    const down = calls.find((c) => c.args.includes("down"));
    expect(down?.args).toEqual([
      "compose", "-p", SELFHOST_COMPOSE_PROJECT, "-f", path.join(installDir, COMPOSE_FILE),
      "down", "-v", "--remove-orphans",
    ]);
    expect(fs.existsSync(installDir)).toBe(false);
    const backup = plan.backupDir!;
    expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(backup, "secrets", "db-password.secret"), "utf-8")).toBe("x");
  });

  it("deletes the install dir with --no-backup", async () => {
    const { run } = fakeDocker();
    const plan = await planReset(opts({ backup: false }), probe(run));
    await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(fs.existsSync(installDir)).toBe(false);
    expect(fs.readdirSync(home).some((n) => n.includes("backup"))).toBe(false);
  });

  it("removes images, CLI and skills only when selected", async () => {
    const cliJson = JSON.stringify({ dependencies: { "@syntropic137/cli": { version: "1.0.0" } } });
    const { run, calls } = fakeDocker({ cliJson });
    const removeSkills = vi.fn().mockResolvedValue(ok());
    const plan = await planReset(opts({ images: true, cli: true, skills: true }), probe(run));
    await executeReset(plan, { run, removeSkills });
    expect(calls.some((c) => c.args[0] === "image" && c.args[1] === "rm")).toBe(true);
    expect(calls.some((c) => c.cmd === "npm" && c.args.join(" ") === "uninstall -g @syntropic137/cli")).toBe(true);
    expect(removeSkills).toHaveBeenCalledWith(["syn-workflow"]);
  });

  it("reports a failed step and carries on", async () => {
    const { run: base } = fakeDocker({ containers: ["c"] });
    const run: SyncRunner = (cmd, args, cwd) => (args.includes("down") ? bad("compose exploded") : base(cmd, args, cwd));
    const plan = await planReset(opts(), probe(run));
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results[0]).toMatchObject({ ok: false, detail: "compose exploded" });
    expect(results.some((r) => r.step.startsWith("backup") && r.ok)).toBe(true);
  });
});

describe("parsers", () => {
  it("reads the compose project name", () => {
    expect(parseComposeProjectName("# hi\nname: syntropic137_selfhost\nservices:\n")).toBe("syntropic137_selfhost");
    expect(parseComposeProjectName('name: "quoted"\n')).toBe("quoted");
    expect(parseComposeProjectName("services:\n  name: nested\n")).toBeNull();
  });

  it("reads the global CLI version", () => {
    expect(parseNpmGlobalVersion('{"dependencies":{"@syntropic137/cli":{"version":"0.9.1"}}}')).toBe("0.9.1");
    expect(parseNpmGlobalVersion("{}")).toBe("");
    expect(parseNpmGlobalVersion("garbage")).toBe("");
  });

  it("ignores images outside ghcr.io/syntropic137", () => {
    expect(parseSyntropicImages("ghcr.io/syntropic137x/evil\tlatest\t<none>\tid\n")).toEqual([]);
  });

  it("formats backup names", () => {
    expect(backupDirFor("/a/b", NOW)).toBe("/a/b.backup-20261014-090507");
  });
});
