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
  executionBlocker,
  githubAppSettingsUrl,
  parseComposeProjectName,
  parseNpmGlobalVersion,
  parseSyntropicImages,
  parseComposeImages,
  sharedLeftoverImages,
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
  fs.writeFileSync(
    path.join(installDir, ".env"),
    "APP_ENVIRONMENT=selfhost\nSYN_VERSION=1.0.0\nSYN_GITHUB_APP_NAME=my-app\nSYN_GITHUB_APP_ORG=acme\n",
  );
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

const OURS = { composeProject: SELFHOST_COMPOSE_PROJECT, selfhostEnv: true };
const NONE = { composeProject: "", selfhostEnv: false };

describe("scope refusals", () => {
  it("refuses the filesystem root", () => {
    expect(() => assertResettableDir("/", home, true, OURS)).toThrow(ResetRefusal);
  });

  it("refuses the home directory and its parents", () => {
    expect(() => assertResettableDir(home, home, true, OURS)).toThrow(/home directory/);
    expect(() => assertResettableDir(root, home, true, OURS)).toThrow(/home directory/);
  });

  it("refuses an existing dir without Syntropic137 evidence", () => {
    expect(() => assertResettableDir(installDir, home, true, NONE)).toThrow(/does not look like/);
  });

  it("accepts our compose file, the selfhost .env, or a missing dir", () => {
    expect(() => assertResettableDir(installDir, home, true, { composeProject: SELFHOST_COMPOSE_PROJECT, selfhostEnv: false })).not.toThrow();
    expect(() => assertResettableDir(installDir, home, true, { composeProject: "", selfhostEnv: true })).not.toThrow();
    expect(() => assertResettableDir(installDir, home, false, NONE)).not.toThrow();
  });

  it("refuses an unrelated project that merely has a .env", async () => {
    const project = path.join(home, "code", "my-app");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, ".env"), "DATABASE_URL=postgres://x\n");
    const { run, calls } = fakeDocker();
    await expect(planReset(opts({ installDir: project }), probe(run))).rejects.toThrow(/does not look like/);
    expect(calls).toHaveLength(0);
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

  it("refuses a symlinked install dir", async () => {
    const link = path.join(home, "link-to-install");
    fs.symlinkSync(installDir, link);
    await expect(planReset(opts({ installDir: link }), probe(fakeDocker().run))).rejects.toThrow(/symlink/);
  });

  it("sees through a symlinked parent that points at home", async () => {
    // elsewhere/h -> home, so elsewhere/h/.. is home's parent: refuse.
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(home, path.join(elsewhere, "h"));
    fs.writeFileSync(path.join(home, COMPOSE_FILE), `name: ${SELFHOST_COMPOSE_PROJECT}\n`);
    await expect(planReset(opts({ installDir: path.join(elsewhere, "h") }), probe(fakeDocker().run))).rejects.toThrow(/symlink/);
    const viaParent = path.join(elsewhere, "h", ".syntropic137");
    const plan = await planReset(opts({ installDir: viaParent }), probe(fakeDocker().run));
    expect(plan.installDir).toBe(fs.realpathSync(installDir));
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
    expect(listing.length).toBe(3);
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
    expect(withBackup.backupDir).toBe(`${fs.realpathSync(installDir)}.backup-20261014-090507`);
    const noBackup = await planReset(opts({ backup: false }), probe(fakeDocker().run));
    expect(noBackup.backupDir).toBeNull();
  });

  it("notes when Docker is unavailable, and blocks execution", async () => {
    const plan = await planReset(opts({ images: true }), probe(fakeDocker({ docker: false }).run));
    expect(plan.compose).toBeNull();
    expect(plan.images).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/Docker is not running/);
    expect(executionBlocker(plan)).toMatch(/Start Docker/);
  });

  it("refuses when a Docker listing fails rather than treating it as empty", async () => {
    const { run: base } = fakeDocker();
    const run: SyncRunner = (cmd, args, cwd) => (args[0] === "volume" ? bad("permission denied") : base(cmd, args, cwd));
    await expect(planReset(opts(), probe(run))).rejects.toThrow(/Could not list Docker volumes/);
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
      `Docker resources of compose project "${SELFHOST_COMPOSE_PROJECT}"`,
      "Images (ghcr.io/syntropic137/*)",
      "Install directory",
    ]);
    expect(groups[0]!.items).toEqual(["container syn137-api", "volume v1"]);
    expect(groups[2]!.items[0]).toContain(".backup-20261014-090507");

    // Planning ran only read-only commands and left the install in place.
    const mutating = calls.filter((c) => ["down", "rm", "uninstall"].some((v) => c.args.includes(v)));
    expect(executionBlocker(plan)).toBeNull();
    expect(mutating).toHaveLength(0);
    expect(fs.existsSync(installDir)).toBe(true);
  });
});

describe("executeReset", () => {
  it("backs up first (chmod 700), then removes only labelled resources by name", async () => {
    const { run, calls } = fakeDocker({ containers: ["syn137-api"], volumes: ["syn137_db_data"], networks: ["syn137_internal"] });
    const plan = await planReset(opts(), probe(run));
    const before = calls.length;
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[0]!.step).toMatch(/^backup/);

    const exec = calls.slice(before).filter((c) => c.args.includes("rm"));
    expect(exec.map((c) => c.args)).toEqual([
      ["rm", "-f", "syn137-api"],
      ["network", "rm", "syn137_internal"],
      ["volume", "rm", "syn137_db_data"],
    ]);
    expect(calls.some((c) => c.args.includes("down"))).toBe(false);
    expect(fs.existsSync(installDir)).toBe(false);
    const backup = plan.backupDir!;
    expect(fs.statSync(backup).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(backup, "secrets", "db-password.secret"), "utf-8")).toBe("x");
  });

  it("aborts before touching Docker when the backup cannot be made", async () => {
    const { run, calls } = fakeDocker({ containers: ["c"], volumes: ["v"] });
    const plan = await planReset(opts(), probe(run));
    fs.mkdirSync(plan.backupDir!);
    const before = calls.length;
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(calls.slice(before)).toHaveLength(0);
    expect(fs.existsSync(installDir)).toBe(true);
  });

  it("refuses when the install dir was swapped after planning", async () => {
    const { run, calls } = fakeDocker({ containers: ["c"] });
    const plan = await planReset(opts({ backup: false }), probe(run));
    fs.renameSync(installDir, `${installDir}-moved`);
    fs.mkdirSync(installDir);
    fs.writeFileSync(path.join(installDir, "precious.txt"), "keep me");
    const before = calls.length;
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results).toEqual([expect.objectContaining({ ok: false })]);
    expect(calls.slice(before)).toHaveLength(0);
    expect(fs.existsSync(path.join(installDir, "precious.txt"))).toBe(true);
  });

  it("keeps the install dir when Docker cleanup fails under --no-backup", async () => {
    const { run: base } = fakeDocker({ containers: ["c"] });
    const run: SyncRunner = (cmd, args, cwd) => (args[0] === "rm" ? bad("container busy") : base(cmd, args, cwd));
    const plan = await planReset(opts({ backup: false }), probe(run));
    const results = await executeReset(plan, { run, removeSkills: vi.fn() });
    expect(results.find((r) => r.step === "remove containers")).toMatchObject({ ok: false, detail: "container busy" });
    expect(results.find((r) => r.step.startsWith("delete"))).toMatchObject({ ok: false });
    expect(fs.existsSync(installDir)).toBe(true);
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
});

describe("shared images note", () => {
  it("names the compose file's third-party images that --images leaves in place", async () => {
    fs.writeFileSync(
      path.join(installDir, COMPOSE_FILE),
      `name: ${SELFHOST_COMPOSE_PROJECT}\nservices:\n  redis:\n    image: redis:7-alpine\n`,
    );
    const plan = await planReset(opts({ images: true }), probe(fakeDocker().run));
    const note = plan.notes.find((n) => n.startsWith("Not removed"));
    expect(note).toContain("redis:7-alpine");
    expect(note).toContain("docker image rm redis:7-alpine");
    expect(plan.images).not.toContain("redis:7-alpine");
  });

  it("adds no note without --images", async () => {
    const plan = await planReset(opts(), probe(fakeDocker().run));
    expect(plan.notes.some((n) => n.startsWith("Not removed"))).toBe(false);
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

  it("reads every image a compose file names", () => {
    const yaml = [
      "services:",
      "  db:",
      "    image: timescale/timescaledb:2.29.2-pg16",
      "  api:",
      "    image: ghcr.io/syntropic137/syn-api@sha256:abc",
      "  redis:",
      '    image: "redis:7.2.5-alpine" # pinned',
    ].join("\n");
    expect(parseComposeImages(yaml)).toEqual([
      "ghcr.io/syntropic137/syn-api@sha256:abc",
      "redis:7.2.5-alpine",
      "timescale/timescaledb:2.29.2-pg16",
    ]);
  });

  // Found in the fresh-install rehearsal: reset --all left the workspace image
  // the first run pulled (2.7 GB) and the compose file's third-party images.
  it("lists shared images the install pulled that --images leaves in place", () => {
    const ls = [
      "ghcr.io/syntropic137/syn-api\t<none>\t<none>\teec1dc59d564",
      "ghcr.io/agentparadise/agentic-workspace-toolchain\t<none>\t<none>\t4a76c184a8d3",
      "redis\t7.2.5-alpine\t<none>\t6aaf3f5e6bc8",
      "redis\t7-alpine\t<none>\t111111111111",
      "postgres\t16-alpine\t<none>\t222222222222",
    ].join("\n");
    const compose = ["redis:7.2.5-alpine", "ghcr.io/syntropic137/syn-api@sha256:abc", "minio/minio:RELEASE.x"];
    expect(sharedLeftoverImages(ls, compose)).toEqual(["4a76c184a8d3", "redis:7.2.5-alpine"]);
  });

  it("formats backup names", () => {
    expect(backupDirFor("/a/b", NOW)).toBe("/a/b.backup-20261014-090507");
  });
});
