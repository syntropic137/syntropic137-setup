import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./ui.js", () => ({
  bold: (s: string) => s,
  dim: (s: string) => s,
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
}));

import {
  SkillsManager,
  formatCommand,
  manualInstallCommand,
  marketplaceListHasLegacy,
  nodeSupportsSkillsCli,
  onPath,
  parseInstalledSkills,
  pluginListHasLegacy,
  skillsAddArgs,
  skillsRemoveArgs,
  type CommandResult,
  type CommandRunner,
} from "./skills.js";
import { SKILLS_AGENTS, SKILLS_CLI_PACKAGE, SKILLS_REPO } from "./constants.js";
import { info, success, warn } from "./ui.js";

const ok = (stdout = ""): CommandResult => ({ ok: true, stdout, stderr: "" });
const bad = (stderr = "boom"): CommandResult => ({ ok: false, stdout: "", stderr, error: "exit 1" });

interface Call { cmd: string; args: readonly string[] }

/** Fake machine: which binaries exist, and canned output per command. */
function fakeRunner(opts: {
  pluginList?: string;
  marketplaceList?: string;
  add?: CommandResult;
  list?: CommandResult;
}): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "claude" && args.join(" ") === "plugin list") return ok(opts.pluginList ?? "");
    if (cmd === "claude" && args.join(" ") === "plugin marketplace list") return ok(opts.marketplaceList ?? "");
    if (cmd === "claude") return ok();
    if (cmd === "npx" && args[2] === "add") return opts.add ?? ok();
    if (cmd === "npx" && args[2] === "ls") return opts.list ?? ok(LIST_JSON);
    return bad(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { run, calls };
}

const LIST_JSON = JSON.stringify([
  { name: "syn-workflow", path: "/h/.agents/skills/syn-workflow", source: SKILLS_REPO },
  { name: "execution-control", path: "/h/.agents/skills/execution-control", source: `https://github.com/${SKILLS_REPO}.git` },
  { name: "frontend-design", path: "/h/.agents/skills/frontend-design", source: "someone/else" },
]);

function manager(
  run: CommandRunner,
  o: { bins?: string[]; node?: string; interactive?: boolean; assumeYes?: boolean; answer?: boolean } = {},
) {
  const confirm = vi.fn().mockResolvedValue(o.answer ?? true);
  const bins = new Set(o.bins ?? []);
  const m = new SkillsManager({
    run,
    locate: (bin) => bins.has(bin),
    nodeVersion: o.node ?? "22.17.1",
    confirm,
    interactive: o.interactive ?? false,
    assumeYes: o.assumeYes ?? false,
  });
  return { m, confirm };
}

const allOutput = () =>
  [...vi.mocked(info).mock.calls, ...vi.mocked(warn).mock.calls, ...vi.mocked(success).mock.calls]
    .map((c) => String(c[0]))
    .join("\n");

beforeEach(() => vi.clearAllMocks());

describe("command construction", () => {
  it("pins the skills CLI to an exact version", () => {
    expect(SKILLS_CLI_PACKAGE).toMatch(/^skills@\d+\.\d+\.\d+$/);
  });

  it("installs every skill globally, non-interactively, for the given agents", () => {
    expect(skillsAddArgs(SKILLS_AGENTS)).toEqual([
      "-y", SKILLS_CLI_PACKAGE, "add", SKILLS_REPO, "--skill", "*", "-g",
      "-a", "claude-code", "-a", "codex", "-y",
    ]);
  });

  it("only targets detected agents", () => {
    const codexOnly = SKILLS_AGENTS.filter((a) => a.id === "codex");
    const args = skillsAddArgs(codexOnly);
    expect(args).toContain("codex");
    expect(args).not.toContain("claude-code");
  });

  it("builds a global non-interactive remove", () => {
    expect(skillsRemoveArgs(["a", "b"])).toEqual(["-y", SKILLS_CLI_PACKAGE, "remove", "-g", "-y", "a", "b"]);
  });

  it("quotes the glob in the printed manual command", () => {
    expect(manualInstallCommand()).toBe(
      `npx -y ${SKILLS_CLI_PACKAGE} add ${SKILLS_REPO} --skill '*' -g -a claude-code -a codex -y`,
    );
    expect(formatCommand("echo", ["it's"])).toBe(`echo 'it'\\''s'`);
  });
});

describe("parsing", () => {
  it("keeps only Syntropic137 skills from skills ls --json", () => {
    expect(parseInstalledSkills(LIST_JSON)?.map((s) => s.name)).toEqual(["execution-control", "syn-workflow"]);
  });

  it("returns null for non-JSON output", () => {
    expect(parseInstalledSkills("not json")).toBeNull();
    expect(parseInstalledSkills("{}")).toBeNull();
  });

  it("detects the legacy plugin and marketplace in text output", () => {
    expect(pluginListHasLegacy("  ❯ syntropic137@syntropic137\n    Version: 1")).toBe(true);
    expect(pluginListHasLegacy("  ❯ hindsight-memory@hindsight")).toBe(false);
    expect(marketplaceListHasLegacy("  ❯ syntropic137\n    Source: GitHub (syntropic137/syntropic137-claude-plugin)")).toBe(true);
    expect(marketplaceListHasLegacy("  ❯ syntropic137\n")).toBe(true);
    expect(marketplaceListHasLegacy("  ❯ syntropic137-other\n  ❯ hindsight")).toBe(false);
  });
});

const BOTH = ["claude", "codex"];

describe("SkillsManager.install", () => {
  it("installs for both agents when claude and codex are present", async () => {
    const { run, calls } = fakeRunner({});
    const { m } = manager(run, { bins: BOTH });
    expect(await m.install()).toBe("installed");
    const add = calls.find((c) => c.cmd === "npx" && c.args[2] === "add");
    expect(add?.args).toEqual(skillsAddArgs(SKILLS_AGENTS));
    expect(allOutput()).toContain("Claude Code and Codex (2 skills)");
  });

  it("installs for codex only when claude is missing, and skips the plugin check", async () => {
    const { run, calls } = fakeRunner({});
    const { m } = manager(run, { bins: ["codex"] });
    expect(await m.install()).toBe("installed");
    const add = calls.find((c) => c.cmd === "npx" && c.args[2] === "add");
    expect(add?.args).not.toContain("claude-code");
    expect(calls.some((c) => c.cmd === "claude")).toBe(false);
  });

  it("explains and prints the manual command when no agent is installed", async () => {
    const { run, calls } = fakeRunner({});
    const { m } = manager(run, { bins: [] });
    expect(await m.install()).toBe("no-agents");
    expect(calls.some((c) => c.cmd === "npx")).toBe(false);
    expect(allOutput()).toContain(manualInstallCommand());
  });

  it("refuses to run the skills CLI on a Node it cannot run on", async () => {
    const { run, calls } = fakeRunner({});
    const { m } = manager(run, { bins: BOTH, node: "18.20.8" });
    expect(await m.install()).toBe("unsupported-node");
    expect(calls.some((c) => c.cmd === "npx")).toBe(false);
    expect(allOutput()).toContain("Node 20.12 or newer");
  });

  it("warns with the manual command instead of throwing when the install fails", async () => {
    const { run } = fakeRunner({ add: bad("network down") });
    const { m } = manager(run, { bins: ["claude"] });
    expect(await m.install()).toBe("failed");
    const out = allOutput();
    expect(out).toContain("network down");
    expect(out).toContain(`--skill '*' -g -a claude-code -y`);
  });

  it("treats exit 0 with no skills on disk as a failure", async () => {
    const { run } = fakeRunner({ list: ok("[]") });
    const { m } = manager(run, { bins: BOTH });
    expect(await m.install()).toBe("failed");
  });
});

describe("legacy plugin migration", () => {
  const legacy = {
    pluginList: "  ❯ syntropic137@syntropic137\n",
    marketplaceList: "  ❯ syntropic137\n    Source: GitHub (syntropic137/syntropic137-claude-plugin)\n",
  };
  const removals = (calls: Call[]) =>
    calls.filter((c) => c.cmd === "claude" && (c.args[1] === "uninstall" || c.args[2] === "remove"));

  it("does nothing when the plugin is absent", async () => {
    const { run, calls } = fakeRunner({});
    const { m, confirm } = manager(run, { bins: ["claude"], interactive: true });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(0);
  });

  it("uninstalls plugin and marketplace after the skills are installed, when the user agrees", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { bins: ["claude"], interactive: true, answer: true });
    await m.install();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(removals(calls).map((c) => c.args.join(" "))).toEqual([
      "plugin uninstall syntropic137@syntropic137",
      "plugin marketplace remove syntropic137",
    ]);
    const addAt = calls.findIndex((c) => c.cmd === "npx" && c.args[2] === "add");
    const firstRemoval = calls.findIndex((c) => c.cmd === "claude" && c.args[1] === "uninstall");
    expect(addAt).toBeGreaterThanOrEqual(0);
    expect(firstRemoval).toBeGreaterThan(addAt);
  });

  it("never removes the plugin when the skills install failed", async () => {
    const { run, calls } = fakeRunner({ ...legacy, add: bad("offline") });
    const { m, confirm } = manager(run, { bins: ["claude"], interactive: true, assumeYes: true });
    expect(await m.install()).toBe("failed");
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(0);
  });

  it("keeps the plugin and prints the commands when the user declines", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m } = manager(run, { bins: ["claude"], interactive: true, answer: false });
    await m.install();
    expect(removals(calls)).toHaveLength(0);
    expect(allOutput()).toContain("claude plugin uninstall syntropic137@syntropic137");
  });

  it("never removes without consent in non-interactive mode", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { bins: ["claude"], interactive: false });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(0);
    expect(allOutput()).toContain("claude plugin marketplace remove syntropic137");
  });

  it("removes without prompting when --yes was given", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { bins: ["claude"], interactive: false, assumeYes: true });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(2);
  });
});

describe("SkillsManager.status", () => {
  it("reports installed skills", async () => {
    const { run } = fakeRunner({});
    const { m } = manager(run, { bins: BOTH });
    expect(await m.status()).toBe(true);
    expect(allOutput()).toContain("2 Syntropic137 skills installed");
  });

  it("returns false and prints the install command when none are installed", async () => {
    const { run } = fakeRunner({ list: ok("[]") });
    const { m } = manager(run, { bins: ["codex"] });
    expect(await m.status()).toBe(false);
    expect(allOutput()).toContain("No Syntropic137 skills installed");
  });
});

describe("environment checks", () => {
  it("finds executables on PATH without running them", () => {
    const files = new Set(["/usr/local/bin/claude", "C:\\tools\\codex.CMD"]);
    const isFile = (p: string) => files.has(p);
    expect(onPath("claude", { PATH: "/usr/bin:/usr/local/bin" }, "darwin", isFile)).toBe(true);
    expect(onPath("codex", { PATH: "/usr/bin:/usr/local/bin" }, "darwin", isFile)).toBe(false);
  });

  it("accepts Node 20.12+ and rejects older", () => {
    expect(nodeSupportsSkillsCli("18.20.8")).toBe(false);
    expect(nodeSupportsSkillsCli("20.11.1")).toBe(false);
    expect(nodeSupportsSkillsCli("20.12.0")).toBe(true);
    expect(nodeSupportsSkillsCli("22.17.1")).toBe(true);
  });
});
