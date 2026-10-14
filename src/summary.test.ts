import { describe, it, expect } from "vitest";
import { renderBox, summaryLines, visibleLength, wrapWords } from "./ui.js";
import { firstRunActions, isThisInstall } from "./cli.js";
import { BIN, COMMANDS } from "./constants.js";

const base = { healthy: true, port: "8137", installDir: "/Users/someone/.syntropic137", showCredentials: true, skillsInstalled: true };

describe("summary box", () => {
  // The 1.0.1 box padded commands to 30 columns, so `... setup status` (30
  // chars) ran into its description ("statusShow container health") and the
  // longer lines pushed the right border out of line.
  it("draws every line at the same width, so the border stays aligned", () => {
    const lines = renderBox(summaryLines({ ...base, actions: ["word ".repeat(40).trim(), "a".repeat(120)] }));
    const widths = new Set(lines.map(visibleLength));
    expect(widths.size).toBe(1);
  });

  it("separates every command from its description", () => {
    const lines = summaryLines(base);
    for (const c of COMMANDS) {
      const line = lines.find((l) => l.includes(`${BIN} ${c.name} `) && l.includes(c.description));
      expect(line, c.name).toBeDefined();
      expect(line!).toMatch(new RegExp(`${BIN} ${c.name} {2,}`.replace(/[@/]/g, "\\$&")));
    }
  });

  it("lists first-run actions only when there are some", () => {
    expect(summaryLines(base).join("\n")).not.toContain("Before your first workflow run");
    const text = summaryLines({ ...base, actions: ["Do the thing"] }).join("\n");
    expect(text).toContain("Before your first workflow run");
    expect(text).toContain("Do the thing");
  });
});

describe("firstRunActions", () => {
  const ready = {
    hasAnthropicCredential: true,
    hasGithubApp: true,
    cliInstalled: true,
    envPath: "/x/.env",
    port: "8137",
    synApiUrl: undefined,
  };

  it("is empty when nothing is missing", () => {
    expect(firstRunActions(ready)).toEqual([]);
    expect(firstRunActions({ ...ready, synApiUrl: "http://localhost:8137" })).toEqual([]);
  });

  it("names each missing piece", () => {
    const out = firstRunActions({ ...ready, hasAnthropicCredential: false, hasGithubApp: false, cliInstalled: false });
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(out[0]).toContain("/x/.env");
    expect(out[1]).toContain("GitHub App");
    expect(out[2]).toContain(`${BIN} cli`);
  });

  // A SYN_API_URL left in the shell points syn and the agent skills at another
  // deployment, silently, right after a fresh local install.
  it("warns when SYN_API_URL points somewhere else", () => {
    const out = firstRunActions({ ...ready, synApiUrl: "http://100.64.0.7:8137" });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("http://100.64.0.7:8137");
    expect(out[0]).toContain("unset SYN_API_URL");
  });
});

describe("isThisInstall", () => {
  it.each([
    ["http://localhost:8137", true],
    ["http://127.0.0.1:8137/", true],
    ["http://[::1]:8137", true],
    ["http://localhost:9137", false],
    ["http://localhost", false],
    ["http://100.64.0.7:8137", false],
    ["https://syn.example.com", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isThisInstall(url, "8137")).toBe(expected);
  });
});

describe("wrapWords", () => {
  it("wraps at the width and keeps every word", () => {
    const text = "one two three four five six seven eight nine ten";
    const lines = wrapWords(text, 14);
    expect(lines.every((l) => l.length <= 14)).toBe(true);
    expect(lines.join(" ")).toBe(text);
  });

  it("keeps a long first-run action from widening the box", () => {
    const without = renderBox(summaryLines(base));
    const withLong = renderBox(summaryLines({ ...base, actions: ["word ".repeat(60).trim()] }));
    expect(visibleLength(withLong[0]!)).toBe(visibleLength(without[0]!));
  });
});
