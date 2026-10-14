import { describe, it, expect, afterEach } from "vitest";
import { prompt, promptSecret } from "./ui.js";

// Codex review of #84: once stdin has ended, a listener attached afterwards
// never hears EOF, so a second prompt waited forever and the process exited 0
// mid-setup. Both prompts must answer at once from an ended stdin.
describe("prompts on an ended stdin", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, "readableEnded");
  afterEach(() => {
    if (desc) Object.defineProperty(process.stdin, "readableEnded", desc);
    else delete (process.stdin as { readableEnded?: boolean }).readableEnded;
  });

  it("prompt resolves the default and promptSecret resolves empty, in sequence", async () => {
    Object.defineProperty(process.stdin, "readableEnded", { value: true, configurable: true });
    await expect(prompt("first", "dflt")).resolves.toBe("dflt");
    await expect(prompt("second")).resolves.toBe("");
    await expect(promptSecret("secret")).resolves.toBe("");
  });
});
