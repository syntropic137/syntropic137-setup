import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { nodeVersionProblem } from "./cli.js";
import { MIN_NODE } from "./constants.js";

// The skills CLI needs 20.12, but setup claimed Node 18+ and let an older Node
// get halfway through init before anything said so.
describe("nodeVersionProblem", () => {
  it.each(["20.12.0", "20.19.1", "22.17.1", "24.0.0"])("accepts %s", (v) => {
    expect(nodeVersionProblem(v)).toBeNull();
  });

  it.each(["18.20.8", "20.11.1", "19.9.0", "16.0.0"])("rejects %s with a clear message", (v) => {
    const msg = nodeVersionProblem(v);
    expect(msg).toContain("Node 20.12 or newer");
    expect(msg).toContain(v);
    expect(msg).toContain("nodejs.org");
  });
});

describe("the stated minimum agrees everywhere", () => {
  const root = path.resolve(__dirname, "..");
  const min = `${MIN_NODE[0]}.${MIN_NODE[1]}`;

  it("package.json engines", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    expect(pkg.engines.node).toBe(`>=${min}.0`);
  });

  it("README and SECURITY.md never claim an older Node", () => {
    for (const f of ["README.md", "SECURITY.md"]) {
      const text = fs.readFileSync(path.join(root, f), "utf-8");
      expect(text, f).not.toMatch(/Node 1[0-9]\+/);
      expect(text, f).toContain(`Node ${min}+`);
    }
  });

  it("CI runs the built CLI on the minimum itself", () => {
    const ci = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8");
    expect(ci).toContain(`node-version: "${min}.0"`);
    expect(ci).toContain(`needs Node ${min} or newer`);
  });
});
