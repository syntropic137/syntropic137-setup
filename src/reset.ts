/**
 * Factory reset: remove a Syntropic137 self-host install so the next
 * `init` starts from nothing.
 *
 * Safe by construction:
 *   - planning is separate from execution, and the CLI only executes with --yes
 *   - the install dir must look like an install, and is never $HOME or /
 *   - Docker resources are selected by the selfhost compose project label only,
 *     and removed by name from that label query (never `compose down`, which
 *     can reach volumes outside the project by explicit name)
 *   - the install dir is backed up (chmod 700) unless --no-backup
 *   - the GitHub App on github.com is never touched
 *
 * Every subprocess uses execFile/execFileSync with an argument array.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  COMPOSE_FILE,
  GITHUB_BASE,
  GITHUB_SLUG_RE,
  SELFHOST_COMPOSE_PROJECT,
  SYN_CLI_PACKAGE,
  SYNTROPIC137_IMAGE_PREFIX,
} from "./constants.js";
import { parseEnv } from "./config.js";
import type { CommandResult } from "./skills.js";
import { bold, cyan, dim, fail, info, success, warn } from "./ui.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResetOptions {
  installDir: string;
  /** Move the install dir to a timestamped backup instead of deleting it. */
  backup: boolean;
  images: boolean;
  cli: boolean;
  skills: boolean;
}

export type SyncRunner = (cmd: string, args: readonly string[], cwd?: string) => CommandResult;

export interface ResetProbe {
  run: SyncRunner;
  /** Names of the installed Syntropic137 skills, or null if they could not be listed. */
  listSkills: () => Promise<string[] | null>;
  homedir: string;
  now: Date;
}

export interface ComposeTargets {
  project: string;
  containers: string[];
  volumes: string[];
  networks: string[];
}

export interface ResetPlan {
  installDir: string;
  installDirExists: boolean;
  /** Filesystem identity of the install dir when planned, to detect a swap. */
  installDirId: { dev: number; ino: number } | null;
  /** Where the install dir goes; null means delete outright. */
  backupDir: string | null;
  /** null when Docker is unavailable. */
  compose: ComposeTargets | null;
  /** Image references to remove; null when not requested. */
  images: string[] | null;
  /** Installed CLI version; null when not requested, "" when requested but absent. */
  cli: string | null;
  /** Skill names; null when not requested or not listable. */
  skills: string[] | null;
  skillsRequested: boolean;
  githubApp: { slug: string; org: string | null } | null;
  notes: string[];
}

export class ResetRefusal extends Error {}

// ---------------------------------------------------------------------------
// Scope checks (pure)
// ---------------------------------------------------------------------------

/** What the install dir contains that marks it as a Syntropic137 install. */
export interface InstallEvidence {
  /** `name:` declared by the compose file, "" if the file is absent, null if it has none. */
  composeProject: string | null;
  /** .env written by `init`: APP_ENVIRONMENT=selfhost and SYN_VERSION set. */
  selfhostEnv: boolean;
}

/**
 * Refuse any install dir we cannot be sure is ours: the filesystem root, the
 * home directory or anything above it, and an existing directory without
 * Syntropic137-specific evidence (our compose file, or the .env `init` writes).
 * Paths must already be canonical (symlinks resolved).
 */
export function assertResettableDir(installDir: string, homedir: string, exists: boolean, evidence: InstallEvidence): void {
  const dir = path.resolve(installDir);
  const home = path.resolve(homedir);
  if (dir === path.parse(dir).root) {
    throw new ResetRefusal(`Refusing to reset the filesystem root: ${dir}`);
  }
  if (dir === home || home.startsWith(dir + path.sep)) {
    throw new ResetRefusal(`Refusing to reset ${dir}: it is your home directory or contains it.`);
  }
  if (!exists) return;
  if (evidence.composeProject !== "" && evidence.composeProject !== SELFHOST_COMPOSE_PROJECT) {
    throw new ResetRefusal(
      `Refusing to reset: ${path.join(dir, COMPOSE_FILE)} declares compose project ` +
        `"${evidence.composeProject ?? "(none)"}", not "${SELFHOST_COMPOSE_PROJECT}".`,
    );
  }
  if (evidence.composeProject !== SELFHOST_COMPOSE_PROJECT && !evidence.selfhostEnv) {
    throw new ResetRefusal(
      `Refusing to reset ${dir}: it has neither the Syntropic137 ${COMPOSE_FILE} nor a selfhost .env, ` +
        "so it does not look like a Syntropic137 install.",
    );
  }
}

/** Is this the .env `init` writes? */
export function isSelfhostEnv(env: Record<string, string>): boolean {
  return env.APP_ENVIRONMENT === "selfhost" && Boolean(env.SYN_VERSION);
}

/** Canonical path: symlinks in the parents resolved; the target itself must not be a symlink. */
export function canonicalInstallDir(installDir: string): { dir: string; exists: boolean } {
  const lexical = path.resolve(installDir);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(lexical);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    throw new ResetRefusal(`Refusing to reset ${lexical}: it is a symlink. Pass the real directory with --dir.`);
  }
  if (st && !st.isDirectory()) {
    throw new ResetRefusal(`Refusing to reset ${lexical}: it is not a directory.`);
  }
  // Resolve the nearest existing ancestor, so a symlinked parent cannot hide $HOME.
  let base = lexical;
  const rest: string[] = [];
  while (!fs.existsSync(base) && path.dirname(base) !== base) {
    rest.unshift(path.basename(base));
    base = path.dirname(base);
  }
  return { dir: path.join(fs.realpathSync(base), ...rest), exists: st !== null };
}

function canonicalHome(homedir: string): string {
  try {
    return fs.realpathSync(homedir);
  } catch {
    return path.resolve(homedir);
  }
}

/** The `name:` a compose file declares, or null. */
export function parseComposeProjectName(composeYaml: string): string | null {
  const m = composeYaml.match(/^name:\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/m);
  return m ? m[1]! : null;
}

/** `<dir>.backup-YYYYMMDD-HHMMSS`, a sibling of the install dir. */
export function backupDirFor(installDir: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${path.resolve(installDir)}.backup-${stamp}`;
}

/** Image references under ghcr.io/syntropic137/ from `docker image ls` output. */
export function parseSyntropicImages(output: string): string[] {
  const refs = new Set<string>();
  for (const line of output.split("\n")) {
    const [repo, tag, digest, id] = line.trim().split("\t");
    if (!repo || !repo.startsWith(SYNTROPIC137_IMAGE_PREFIX)) continue;
    if (tag && tag !== "<none>") refs.add(`${repo}:${tag}`);
    else if (digest && digest !== "<none>") refs.add(`${repo}@${digest}`);
    else if (id) refs.add(id);
  }
  return [...refs].sort();
}

/** Version of the globally installed syn CLI from `npm ls -g --json`, or "". */
export function parseNpmGlobalVersion(json: string): string {
  try {
    const data = JSON.parse(json) as { dependencies?: Record<string, { version?: unknown }> };
    const v = data.dependencies?.[SYN_CLI_PACKAGE]?.version;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const projectLabel = (project: string) => `label=com.docker.compose.project=${project}`;

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function planReset(opts: ResetOptions, probe: ResetProbe): Promise<ResetPlan> {
  const { dir: installDir, exists } = canonicalInstallDir(opts.installDir);
  const home = canonicalHome(probe.homedir);

  const composePath = path.join(installDir, COMPOSE_FILE);
  const envPath = path.join(installDir, ".env");
  const env = exists && fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, "utf-8")) : {};
  const evidence: InstallEvidence = {
    composeProject: exists && fs.existsSync(composePath)
      ? parseComposeProjectName(fs.readFileSync(composePath, "utf-8"))
      : "",
    selfhostEnv: isSelfhostEnv(env),
  };
  assertResettableDir(installDir, home, exists, evidence);

  const notes: string[] = [];

  // Docker resources: only what carries the selfhost project label.
  let compose: ComposeTargets | null = null;
  if (probe.run("docker", ["info"]).ok) {
    const project = SELFHOST_COMPOSE_PROJECT;
    const ls = (what: string, args: string[]) => {
      const r = probe.run("docker", args);
      if (!r.ok) throw new ResetRefusal(`Could not list Docker ${what}: ${(r.stderr || r.error || "").trim()}`);
      return lines(r.stdout);
    };
    compose = {
      project,
      containers: ls("containers", ["ps", "-a", "--filter", projectLabel(project), "--format", "{{.Names}}"]),
      volumes: ls("volumes", ["volume", "ls", "--filter", projectLabel(project), "--format", "{{.Name}}"]),
      networks: ls("networks", ["network", "ls", "--filter", projectLabel(project), "--format", "{{.Name}}"]),
    };
  } else {
    notes.push("Docker is not running or not installed: containers, volumes and images were not checked.");
  }

  let images: string[] | null = null;
  if (opts.images) {
    if (compose) {
      const r = probe.run("docker", ["image", "ls", "--format", "{{.Repository}}\t{{.Tag}}\t{{.Digest}}\t{{.ID}}"]);
      if (!r.ok) throw new ResetRefusal(`Could not list Docker images: ${(r.stderr || r.error || "").trim()}`);
      images = parseSyntropicImages(r.stdout);
    } else {
      images = [];
    }
  }

  let cli: string | null = null;
  if (opts.cli) {
    const r = probe.run("npm", ["ls", "-g", SYN_CLI_PACKAGE, "--depth=0", "--json"]);
    cli = parseNpmGlobalVersion(r.stdout);
  }

  let skills: string[] | null = null;
  if (opts.skills) {
    skills = await probe.listSkills();
    if (skills === null) notes.push("Could not list the installed agent skills; they will not be removed.");
  }

  let githubApp: ResetPlan["githubApp"] = null;
  {
    const slug = env.SYN_GITHUB_APP_NAME;
    const org = env.SYN_GITHUB_APP_ORG;
    if (slug && GITHUB_SLUG_RE.test(slug)) {
      githubApp = { slug, org: org && GITHUB_SLUG_RE.test(org) ? org : null };
    }
  }

  return {
    installDir,
    installDirExists: exists,
    installDirId: exists ? (({ dev, ino }) => ({ dev, ino }))(fs.lstatSync(installDir)) : null,
    backupDir: exists && opts.backup ? backupDirFor(installDir, probe.now) : null,
    compose,
    images,
    cli,
    skills,
    skillsRequested: opts.skills,
    githubApp,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

export interface PlanLine {
  section: string;
  items: string[];
}

/** What the plan will remove, grouped for display. Empty groups are omitted. */
export function describePlan(plan: ResetPlan): PlanLine[] {
  const out: PlanLine[] = [];
  if (plan.compose) {
    const c = plan.compose;
    const items = [
      ...c.containers.map((n) => `container ${n}`),
      ...c.volumes.map((n) => `volume ${n}`),
      ...c.networks.map((n) => `network ${n}`),
    ];
    if (items.length > 0) out.push({ section: `Docker resources of compose project "${c.project}"`, items });
  }
  if (plan.images && plan.images.length > 0) {
    out.push({ section: "Images (ghcr.io/syntropic137/*)", items: plan.images });
  }
  if (plan.installDirExists) {
    out.push({
      section: "Install directory",
      items: [plan.backupDir ? `${plan.installDir} (moved to ${plan.backupDir})` : `${plan.installDir} (deleted, no backup)`],
    });
  }
  if (plan.cli) out.push({ section: "syn CLI", items: [`${SYN_CLI_PACKAGE}@${plan.cli} (npm uninstall -g)`] });
  if (plan.skills && plan.skills.length > 0) out.push({ section: "Agent skills (global)", items: plan.skills });
  return out;
}

/** Settings URL of the GitHub App (where it can be deleted). */
export function githubAppSettingsUrl(app: { slug: string; org: string | null }): string {
  return app.org
    ? `${GITHUB_BASE}/organizations/${app.org}/settings/apps/${app.slug}/advanced`
    : `${GITHUB_BASE}/settings/apps/${app.slug}/advanced`;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface ResetStepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

export interface ResetExecDeps {
  run: SyncRunner;
  /** Async runner for the skills CLI removal. */
  removeSkills: (names: string[]) => Promise<CommandResult>;
}

/** Is the install dir still the same, unswapped directory the plan inspected? */
function sameDir(plan: ResetPlan): boolean {
  try {
    const now = canonicalInstallDir(plan.installDir);
    const st = fs.lstatSync(plan.installDir);
    return now.exists && now.dir === plan.installDir && plan.installDirId !== null &&
      st.dev === plan.installDirId.dev && st.ino === plan.installDirId.ino;
  } catch {
    return false;
  }
}

/** Why execution must not start, or null. Checked by the CLI before --yes runs. */
export function executionBlocker(plan: ResetPlan): string | null {
  if (!plan.compose && plan.installDirExists) {
    return "Docker is not running. Start Docker so reset can remove the stack's containers and volumes first.";
  }
  return null;
}

export async function executeReset(plan: ResetPlan, deps: ResetExecDeps): Promise<ResetStepResult[]> {
  const results: ResetStepResult[] = [];
  const record = (step: string, r: CommandResult) => {
    results.push({ step, ok: r.ok, detail: r.ok ? undefined : (r.stderr.trim() || r.error) });
    return r.ok;
  };

  // The install dir must still be the very directory we planned for.
  if (plan.installDirExists && !sameDir(plan)) {
    results.push({ step: `check ${plan.installDir}`, ok: false, detail: "changed since the plan was made (nothing was removed)" });
    return results;
  }

  // 1. Secure the backup before anything irreversible. Abort if it fails.
  if (plan.installDirExists && plan.backupDir) {
    try {
      if (fs.existsSync(plan.backupDir)) throw new Error(`${plan.backupDir} already exists`);
      // Lock it down before the move, so a moved backup is never left readable.
      const mode = fs.statSync(plan.installDir).mode & 0o777;
      fs.chmodSync(plan.installDir, 0o700);
      try {
        fs.renameSync(plan.installDir, plan.backupDir);
      } catch (err) {
        fs.chmodSync(plan.installDir, mode);
        throw err;
      }
      results.push({ step: `backup to ${plan.backupDir}`, ok: true });
    } catch (err) {
      results.push({
        step: `backup to ${plan.backupDir}`,
        ok: false,
        detail: `${err instanceof Error ? err.message : String(err)} (nothing was removed)`,
      });
      return results;
    }
  }

  // 2. Docker resources of our project, re-read by label right now and
  //    removed by name. Never `compose down`: it can reach volumes outside the
  //    project by explicit name.
  let dockerOk = true;
  if (plan.compose) {
    const label = projectLabel(plan.compose.project);
    const now = (args: string[]) => {
      const r = deps.run("docker", args);
      if (!r.ok) dockerOk = record(`docker ${args.slice(0, 2).join(" ")}`, r) && dockerOk;
      return r.ok ? lines(r.stdout) : [];
    };
    const containers = now(["ps", "-a", "--filter", label, "--format", "{{.Names}}"]);
    if (containers.length > 0) dockerOk = record("remove containers", deps.run("docker", ["rm", "-f", ...containers])) && dockerOk;
    const networks = now(["network", "ls", "--filter", label, "--format", "{{.Name}}"]);
    if (networks.length > 0) dockerOk = record("remove networks", deps.run("docker", ["network", "rm", ...networks])) && dockerOk;
    const volumes = now(["volume", "ls", "--filter", label, "--format", "{{.Name}}"]);
    if (volumes.length > 0) dockerOk = record("remove volumes", deps.run("docker", ["volume", "rm", ...volumes])) && dockerOk;
  }

  // 3. Images.
  if (plan.images && plan.images.length > 0) {
    record("docker image rm", deps.run("docker", ["image", "rm", ...plan.images]));
  }

  // 4. Without a backup, delete the dir only once the stack is gone, so a
  //    failed teardown never strands running containers without their config.
  if (plan.installDirExists && !plan.backupDir) {
    if (!dockerOk) {
      results.push({ step: `delete ${plan.installDir}`, ok: false, detail: "skipped: Docker cleanup failed, fix that and re-run" });
    } else if (!sameDir(plan)) {
      results.push({ step: `delete ${plan.installDir}`, ok: false, detail: "skipped: the directory changed during the reset" });
    } else {
      try {
        fs.rmSync(plan.installDir, { recursive: true, force: true });
        results.push({ step: `delete ${plan.installDir}`, ok: true });
      } catch (err) {
        results.push({ step: `delete ${plan.installDir}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 5. syn CLI.
  if (plan.cli) {
    record("npm uninstall -g " + SYN_CLI_PACKAGE, deps.run("npm", ["uninstall", "-g", SYN_CLI_PACKAGE]));
  }

  // 6. Agent skills.
  if (plan.skills && plan.skills.length > 0) {
    record("remove agent skills", await deps.removeSkills(plan.skills));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Default (real machine) runner
// ---------------------------------------------------------------------------

export const defaultSyncRunner: SyncRunner = (cmd, args, cwd) => {
  try {
    const stdout = execFileSync(cmd, [...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      ok: false,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      error: e.message ?? String(err),
    };
  }
};

export const realHome = (): string => os.homedir();

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function printPlan(plan: ResetPlan, execute: boolean): void {
  const groups = describePlan(plan);
  console.log();
  console.log(`  ${bold(execute ? "Factory reset" : "Factory reset (dry run)")}`);
  if (groups.length === 0) {
    info("Nothing to remove: no Syntropic137 install, containers or volumes were found.");
  } else {
    info(execute ? "Removing:" : "Would remove:");
    for (const g of groups) {
      console.log(`      ${bold(g.section)}`);
      for (const item of g.items) console.log(`        ${dim("-")} ${item}`);
    }
  }
  const skipped: string[] = [];
  if (plan.images === null) skipped.push("images (--images)");
  if (plan.cli === null) skipped.push("syn CLI (--cli)");
  if (!plan.skillsRequested) skipped.push("agent skills (--skills)");
  if (skipped.length > 0) info(dim(`Not selected: ${skipped.join(", ")}. --all selects everything.`));
  if (plan.cli === "") info(dim(`${SYN_CLI_PACKAGE} is not installed globally.`));
  for (const n of plan.notes) warn(n);
}

export function printGithubAppNote(plan: ResetPlan): void {
  console.log();
  if (plan.githubApp) {
    warn(`The GitHub App "${plan.githubApp.slug}" still exists on github.com. Reset never touches it.`);
    info(`Delete it: ${cyan(githubAppSettingsUrl(plan.githubApp))} (Delete GitHub App)`);
    if (plan.backupDir) {
      info(`Or reuse it: its private key is kept in ${plan.backupDir}/secrets/`);
    } else {
      info("Or reuse it: generate a new private key in the app settings.");
    }
  } else {
    info(`If you created a GitHub App during setup, it still exists: ${cyan(`${GITHUB_BASE}/settings/apps`)}`);
  }
}

export function printResults(results: readonly ResetStepResult[], plan: ResetPlan): boolean {
  let allOk = true;
  for (const r of results) {
    if (r.ok) success(r.step);
    else {
      allOk = false;
      fail(`${r.step} failed`);
      if (r.detail) info(dim(r.detail.split("\n").slice(-3).join(" ")));
    }
  }
  if (plan.backupDir && results.some((r) => r.ok && r.step.startsWith("backup"))) {
    info(`Backup holds secrets (chmod 700). Delete it when you no longer need it: ${plan.backupDir}`);
  }
  return allOk;
}
