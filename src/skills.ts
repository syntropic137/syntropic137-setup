/**
 * Syntropic137 agent skills: install, update, and inspect them for Claude Code
 * and Codex through the `skills` CLI (pinned, run via npx), and migrate users
 * off the legacy Claude Code plugin that the skills replace.
 *
 * Every subprocess runs through `execFile` with an argument array. There is no
 * shell and no string interpolation into a command line.
 */

import { execFile } from "node:child_process";
import {
  LEGACY_PLUGIN_ID,
  LEGACY_PLUGIN_MARKETPLACE,
  LEGACY_PLUGIN_REPO,
  SKILLS_AGENTS,
  SKILLS_CLI_PACKAGE,
  SKILLS_REPO,
  type SkillsAgent,
} from "./constants.js";
import { bold, dim, info, spinner, success, warn } from "./ui.js";

// ---------------------------------------------------------------------------
// Process runner (injectable so tests never touch the real machine)
// ---------------------------------------------------------------------------

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Spawn or exit error message when `ok` is false. */
  error?: string;
}

export type CommandRunner = (
  cmd: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<CommandResult>;

/** Ten minutes: a cold npx cache plus a git clone can be slow. */
const INSTALL_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 30_000;
const NPX = "npx";

export const defaultRunner: CommandRunner = (cmd, args, timeoutMs = PROBE_TIMEOUT_MS) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      [...args],
      { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: err ? err.message : undefined,
        });
      },
    );
    // Nothing should ever prompt (`-y` everywhere); close stdin so a prompt
    // fails fast instead of hanging the setup.
    child.stdin?.end();
  });

// ---------------------------------------------------------------------------
// Command construction (pure)
// ---------------------------------------------------------------------------

/** `npx` arguments that install every Syntropic137 skill globally for `agents`. */
export function skillsAddArgs(agents: readonly SkillsAgent[]): string[] {
  const args = ["-y", SKILLS_CLI_PACKAGE, "add", SKILLS_REPO, "--skill", "*", "-g"];
  for (const a of agents) args.push("-a", a.id);
  args.push("-y");
  return args;
}

/** `npx` arguments that list global skills as JSON. */
export function skillsListArgs(): string[] {
  return ["-y", SKILLS_CLI_PACKAGE, "ls", "-g", "--json"];
}

/** `npx` arguments that remove the named global skills from every agent. */
export function skillsRemoveArgs(names: readonly string[]): string[] {
  return ["-y", SKILLS_CLI_PACKAGE, "remove", "-g", "-y", ...names];
}

/** Render a command for humans to copy. Quotes only what a shell would mangle. */
export function formatCommand(cmd: string, args: readonly string[]): string {
  const quote = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return [cmd, ...args].map(quote).join(" ");
}

/** The manual install command, covering both supported agents. */
export function manualInstallCommand(agents: readonly SkillsAgent[] = SKILLS_AGENTS): string {
  return formatCommand(NPX, skillsAddArgs(agents));
}

export const LEGACY_PLUGIN_UNINSTALL_ARGS = ["plugin", "uninstall", LEGACY_PLUGIN_ID] as const;
export const LEGACY_MARKETPLACE_REMOVE_ARGS = ["plugin", "marketplace", "remove", LEGACY_PLUGIN_MARKETPLACE] as const;

// ---------------------------------------------------------------------------
// Output parsing (pure)
// ---------------------------------------------------------------------------

export interface InstalledSkill {
  name: string;
  path: string;
}

/**
 * Pick the Syntropic137 skills out of `skills ls -g --json`. Other skills the
 * user installed from other sources are ignored. Returns null when the output
 * is not the expected JSON array.
 */
export function parseInstalledSkills(json: string): InstalledSkill[] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  const out: InstalledSkill[] = [];
  for (const entry of data as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { name?: unknown; path?: unknown; source?: unknown };
    if (typeof e.name !== "string" || typeof e.source !== "string") continue;
    if (normaliseSource(e.source) !== SKILLS_REPO) continue;
    out.push({ name: e.name, path: typeof e.path === "string" ? e.path : "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `owner/repo` from `owner/repo`, `owner/repo#ref` or a GitHub URL. */
function normaliseSource(source: string): string {
  return source
    .trim()
    .toLowerCase()
    .replace(/^(https?:\/\/|git@)github\.com[/:]/, "")
    .replace(/#.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** Does `claude plugin list` output show the legacy plugin? */
export function pluginListHasLegacy(output: string): boolean {
  return output.includes(LEGACY_PLUGIN_ID);
}

/** Does `claude plugin marketplace list` output show the legacy marketplace? */
export function marketplaceListHasLegacy(output: string): boolean {
  if (output.includes(LEGACY_PLUGIN_REPO)) return true;
  // Text form lists each marketplace as "❯ <name>" on its own line.
  return output.split("\n").some((line) => line.replace(/^[\s❯>*-]+/, "").trim() === LEGACY_PLUGIN_MARKETPLACE);
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export async function detectAgents(run: CommandRunner): Promise<SkillsAgent[]> {
  const found: SkillsAgent[] = [];
  for (const agent of SKILLS_AGENTS) {
    if ((await run(agent.bin, ["--version"])).ok) found.push(agent);
  }
  return found;
}

export interface LegacyPluginState {
  plugin: boolean;
  marketplace: boolean;
}

export async function detectLegacyPlugin(run: CommandRunner): Promise<LegacyPluginState> {
  const plugins = await run("claude", ["plugin", "list"]);
  const markets = await run("claude", ["plugin", "marketplace", "list"]);
  return {
    plugin: plugins.ok && pluginListHasLegacy(plugins.stdout),
    marketplace: markets.ok && marketplaceListHasLegacy(markets.stdout),
  };
}

/** Last few meaningful lines of a failed command, for the warning. */
function tail(result: CommandResult, lines = 6): string[] {
  const text = `${result.stderr}\n${result.stdout}`
    // Strip ANSI escapes and box drawing noise from the skills CLI.
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.replace(/^[\s│◇◆└┌├─╮╯]+/, "").trim())
    .filter((l) => l && !l.startsWith("npm notice"));
  const picked = text.slice(-lines);
  if (picked.length === 0 && result.error) picked.push(result.error);
  return picked;
}

// ---------------------------------------------------------------------------
// SkillsManager
// ---------------------------------------------------------------------------

export interface SkillsDeps {
  run: CommandRunner;
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** True when we may prompt the user. */
  interactive: boolean;
  /** Explicit consent (`--yes`) to remove the legacy plugin without asking. */
  assumeYes: boolean;
}

export type InstallOutcome = "installed" | "no-agents" | "failed";

export class SkillsManager {
  constructor(private readonly deps: SkillsDeps) {}

  /**
   * Install (or refresh) every Syntropic137 skill globally for each detected
   * agent. Never throws: failures become a warning plus the manual command.
   */
  async install(): Promise<InstallOutcome> {
    const agents = await detectAgents(this.deps.run);
    if (agents.length === 0) {
      warn("Neither Claude Code (`claude`) nor Codex (`codex`) was found on your PATH.");
      info("The Syntropic137 skills teach your coding agent to drive the platform.");
      info("Install an agent, then run:");
      info(`  ${bold(manualInstallCommand())}`);
      return "no-agents";
    }

    if (agents.some((a) => a.id === "claude-code")) {
      await this.migrateLegacyPlugin();
    }

    const labels = agents.map((a) => a.label).join(" and ");
    const message = `Installing Syntropic137 skills for ${labels} ${dim(`(npx ${SKILLS_CLI_PACKAGE})`)}`;
    // The spinner redraws with \r, which only makes sense on a terminal.
    const spin = process.stdout.isTTY ? spinner(message) : null;
    if (!spin) info(message);
    const result = await this.deps.run(NPX, skillsAddArgs(agents), INSTALL_TIMEOUT_MS);
    spin?.stop();

    if (!result.ok) {
      warn(`Could not install the Syntropic137 skills for ${labels}.`);
      for (const line of tail(result)) info(dim(line));
      info("Install manually:");
      info(`  ${bold(formatCommand(NPX, skillsAddArgs(agents)))}`);
      return "failed";
    }

    const installed = await this.listInstalled();
    const count = installed ? ` (${installed.length} skills)` : "";
    success(`Syntropic137 skills installed for ${labels}${count}`);
    if (installed && installed.length > 0) {
      info(dim(installed.map((s) => s.name).join(", ")));
    }
    return "installed";
  }

  /** Print what is installed, which agents were found, and any legacy plugin. */
  async status(): Promise<boolean> {
    const agents = await detectAgents(this.deps.run);
    for (const a of SKILLS_AGENTS) {
      const found = agents.some((x) => x.id === a.id);
      if (found) success(`${a.label} found (\`${a.bin}\`)`);
      else info(dim(`${a.label} not found (\`${a.bin}\`)`));
    }

    const installed = await this.listInstalled();
    if (installed === null) {
      warn(`Could not read installed skills (npx ${SKILLS_CLI_PACKAGE} ls -g --json failed).`);
    } else if (installed.length === 0) {
      warn("No Syntropic137 skills installed.");
      info(`Install: ${bold(manualInstallCommand(agents.length > 0 ? agents : SKILLS_AGENTS))}`);
    } else {
      success(`${installed.length} Syntropic137 skills installed (global)`);
      for (const s of installed) info(`${s.name} ${dim(s.path)}`);
    }

    if (agents.some((a) => a.id === "claude-code")) {
      const legacy = await detectLegacyPlugin(this.deps.run);
      if (legacy.plugin || legacy.marketplace) {
        warn("The legacy Syntropic137 Claude Code plugin is still installed; it duplicates the skills.");
        this.printLegacyRemovalCommands(legacy);
      }
    }
    return installed !== null && installed.length > 0;
  }

  /** Global Syntropic137 skills, or null when the skills CLI could not list them. */
  async listInstalled(): Promise<InstalledSkill[] | null> {
    const result = await this.deps.run(NPX, skillsListArgs(), INSTALL_TIMEOUT_MS);
    if (!result.ok) return null;
    return parseInstalledSkills(result.stdout);
  }

  /**
   * If the old Claude Code plugin is installed, offer to remove it and its
   * marketplace so commands are not duplicated. Without consent (or when not
   * interactive and no `--yes`) we only print the commands.
   */
  async migrateLegacyPlugin(): Promise<void> {
    const legacy = await detectLegacyPlugin(this.deps.run);
    if (!legacy.plugin && !legacy.marketplace) return;

    warn("Found the legacy Syntropic137 Claude Code plugin.");
    info("The agent skills replace it. Keeping both duplicates commands in Claude Code.");

    let consent = this.deps.assumeYes;
    if (!consent && this.deps.interactive) {
      consent = await this.deps.confirm("Uninstall the plugin and remove the syntropic137 marketplace?", true);
    }
    if (!consent) {
      info("Left it in place. To remove it yourself:");
      this.printLegacyRemovalCommands(legacy);
      return;
    }

    if (legacy.plugin) {
      const r = await this.deps.run("claude", LEGACY_PLUGIN_UNINSTALL_ARGS);
      if (r.ok) success(`Uninstalled plugin ${LEGACY_PLUGIN_ID}`);
      else warn(`Could not uninstall plugin: ${formatCommand("claude", LEGACY_PLUGIN_UNINSTALL_ARGS)}`);
    }
    if (legacy.marketplace) {
      const r = await this.deps.run("claude", LEGACY_MARKETPLACE_REMOVE_ARGS);
      if (r.ok) success(`Removed marketplace ${LEGACY_PLUGIN_MARKETPLACE}`);
      else warn(`Could not remove marketplace: ${formatCommand("claude", LEGACY_MARKETPLACE_REMOVE_ARGS)}`);
    }
  }

  private printLegacyRemovalCommands(legacy: LegacyPluginState): void {
    if (legacy.plugin) info(`  ${bold(formatCommand("claude", LEGACY_PLUGIN_UNINSTALL_ARGS))}`);
    if (legacy.marketplace) info(`  ${bold(formatCommand("claude", LEGACY_MARKETPLACE_REMOVE_ARGS))}`);
  }
}
