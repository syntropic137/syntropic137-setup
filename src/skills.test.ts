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
  bins?: string[];
  pluginList?: string;
  marketplaceList?: string;
  add?: CommandResult;
  list?: CommandResult;
}): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const bins = new Set(opts.bins ?? []);
  const run: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === "--version") return bins.has(cmd) ? ok("1.0.0") : bad("ENOENT");
    if (cmd === "claude" && args.join(" ") === "plugin list") return ok(opts.pluginList ?? "");
    if (cmd === "claude" && args.join(" ") === "plugin marketplace list") return ok(opts.marketplaceList ?? "");
    if (cmd === "claude") return ok();
    if (cmd === "npx" && args[2] === "add") return opts.add ?? ok();
    if (cmd === "npx" && args[2] === "ls") return opts.list ?? ok("[]");
    return bad(`unexpected ${cmd} ${args.join(" ")}`);
  };
  return { run, calls };
}

const LIST_JSON = JSON.stringify([
  { name: "syn-workflow", path: "/h/.agents/skills/syn-workflow", source: SKILLS_REPO },
  { name: "execution-control", path: "/h/.agents/skills/execution-control", source: `https://github.com/${SKILLS_REPO}.git` },
  { name: "frontend-design", path: "/h/.agents/skills/frontend-design", source: "someone/else" },
]);

function manager(run: CommandRunner, o: { interactive?: boolean; assumeYes?: boolean; answer?: boolean } = {}) {
  const confirm = vi.fn().mockResolvedValue(o.answer ?? true);
  const m = new SkillsManager({ run, confirm, interactive: o.interactive ?? false, assumeYes: o.assumeYes ?? false });
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

describe("SkillsManager.install", () => {
  it("installs for both agents when claude and codex are present", async () => {
    const { run, calls } = fakeRunner({ bins: ["claude", "codex"], list: ok(LIST_JSON) });
    const { m } = manager(run);
    expect(await m.install()).toBe("installed");
    const add = calls.find((c) => c.cmd === "npx" && c.args[2] === "add");
    expect(add?.args).toEqual(skillsAddArgs(SKILLS_AGENTS));
    expect(allOutput()).toContain("Claude Code and Codex (2 skills)");
  });

  it("installs for codex only when claude is missing, and skips the plugin check", async () => {
    const { run, calls } = fakeRunner({ bins: ["codex"] });
    const { m } = manager(run);
    expect(await m.install()).toBe("installed");
    const add = calls.find((c) => c.cmd === "npx" && c.args[2] === "add");
    expect(add?.args).not.toContain("claude-code");
    expect(calls.some((c) => c.cmd === "claude" && c.args[0] === "plugin")).toBe(false);
  });

  it("explains and prints the manual command when no agent is installed", async () => {
    const { run, calls } = fakeRunner({ bins: [] });
    const { m } = manager(run);
    expect(await m.install()).toBe("no-agents");
    expect(calls.some((c) => c.cmd === "npx")).toBe(false);
    expect(allOutput()).toContain(manualInstallCommand());
  });

  it("warns with the manual command instead of throwing when the install fails", async () => {
    const { run } = fakeRunner({ bins: ["claude"], add: bad("network down") });
    const { m } = manager(run);
    expect(await m.install()).toBe("failed");
    const out = allOutput();
    expect(out).toContain("network down");
    expect(out).toContain(`--skill '*' -g -a claude-code -y`);
  });
});

describe("legacy plugin migration", () => {
  const legacy = {
    bins: ["claude"],
    pluginList: "  ❯ syntropic137@syntropic137\n",
    marketplaceList: "  ❯ syntropic137\n    Source: GitHub (syntropic137/syntropic137-claude-plugin)\n",
  };
  const removals = (calls: Call[]) =>
    calls.filter((c) => c.cmd === "claude" && (c.args[1] === "uninstall" || c.args[2] === "remove"));

  it("does nothing when the plugin is absent", async () => {
    const { run, calls } = fakeRunner({ bins: ["claude"] });
    const { m, confirm } = manager(run, { interactive: true });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(0);
  });

  it("uninstalls plugin and marketplace when the user agrees", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { interactive: true, answer: true });
    await m.install();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(removals(calls).map((c) => c.args.join(" "))).toEqual([
      "plugin uninstall syntropic137@syntropic137",
      "plugin marketplace remove syntropic137",
    ]);
  });

  it("keeps the plugin and prints the commands when the user declines", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m } = manager(run, { interactive: true, answer: false });
    await m.install();
    expect(removals(calls)).toHaveLength(0);
    expect(allOutput()).toContain("claude plugin uninstall syntropic137@syntropic137");
  });

  it("never removes without consent in non-interactive mode", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { interactive: false });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(0);
    expect(allOutput()).toContain("claude plugin marketplace remove syntropic137");
  });

  it("removes without prompting when --yes was given", async () => {
    const { run, calls } = fakeRunner(legacy);
    const { m, confirm } = manager(run, { interactive: false, assumeYes: true });
    await m.install();
    expect(confirm).not.toHaveBeenCalled();
    expect(removals(calls)).toHaveLength(2);
  });
});

describe("SkillsManager.status", () => {
  it("reports installed skills", async () => {
    const { run } = fakeRunner({ bins: ["claude", "codex"], list: ok(LIST_JSON) });
    const { m } = manager(run);
    expect(await m.status()).toBe(true);
    expect(allOutput()).toContain("2 Syntropic137 skills installed");
  });

  it("returns false and prints the install command when none are installed", async () => {
    const { run } = fakeRunner({ bins: ["codex"], list: ok("[]") });
    const { m } = manager(run);
    expect(await m.status()).toBe(false);
    expect(allOutput()).toContain("No Syntropic137 skills installed");
  });
});
