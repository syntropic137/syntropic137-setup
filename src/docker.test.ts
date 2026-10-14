import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseComposeVersion, checkDocker, DockerService, STATUS_TABLE_FORMAT } from "./docker.js";

// Mock UI to silence output
vi.mock("./ui.js", () => ({
  fail: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({ stop: vi.fn(), update: vi.fn() })),
}));

// Mock templates
vi.mock("./templates.js", () => ({
  syncTemplate: vi.fn(),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";

const mockExecFileSync = vi.mocked(execFileSync);

describe("parseComposeVersion", () => {
  it("parses standard version string", () => {
    expect(parseComposeVersion("Docker Compose version v2.29.1")).toEqual([2, 29, 1]);
  });

  it("parses without v prefix", () => {
    expect(parseComposeVersion("Docker Compose version 2.20.0")).toEqual([2, 20, 0]);
  });

  it("returns null for garbage input", () => {
    expect(parseComposeVersion("not a version")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseComposeVersion("")).toBeNull();
  });

  it("handles single-digit versions", () => {
    expect(parseComposeVersion("v2.0.0")).toEqual([2, 0, 0]);
  });

  it("handles large version numbers", () => {
    expect(parseComposeVersion("v2.100.33")).toEqual([2, 100, 33]);
  });
});

describe("checkDocker", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("succeeds with Compose v2.20+", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: readonly string[], opts?: unknown) => {
      if (args?.[0] === "info") return Buffer.from("");
      // When encoding is specified, execFileSync returns a string
      if (args?.[0] === "compose") return "Docker Compose version v2.29.1";
      return Buffer.from("");
    });

    expect(() => checkDocker()).not.toThrow();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when docker info fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("docker not found");
    });

    expect(() => checkDocker()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when Compose version is below 2.20", () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: readonly string[]) => {
      if (args?.[0] === "info") return Buffer.from("");
      if (args?.[0] === "compose") return "Docker Compose version v2.19.0";
      return Buffer.from("");
    });

    expect(() => checkDocker()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when Compose plugin is missing", () => {
    let callCount = 0;
    mockExecFileSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Buffer.from(""); // docker info succeeds
      throw new Error("compose not found"); // docker compose version fails
    });

    expect(() => checkDocker()).toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("DockerService.start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.from(""));
  });

  it("runs pull then up -d", () => {
    const docker = new DockerService("/tmp/test");
    docker.start();

    const calls = mockExecFileSync.mock.calls;
    const composeArgs = calls.map((c) => (c[1] as string[]).slice(3)); // strip ["compose", "-f", FILE]
    expect(composeArgs).toEqual([["pull"], ["up", "-d"]]);
  });

  it("exits if pull fails", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    mockExecFileSync.mockImplementation(() => {
      throw new Error("network error");
    });

    const docker = new DockerService("/tmp/test");
    expect(() => docker.start()).toThrow("process.exit");
    exitSpy.mockRestore();
  });
});

describe("DockerService progress and status output", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(Buffer.from(""));
  });

  // A synchronous pull blocks the event loop, so a spinner can never animate:
  // it froze on its first frame for the whole first-install download. Compose
  // must stream its own progress to the terminal instead.
  it("streams pull and up progress to the terminal", () => {
    new DockerService("/tmp/test").start();
    const stdios = mockExecFileSync.mock.calls.map((c) => (c[2] as { stdio?: unknown }).stdio);
    expect(stdios).toEqual(["inherit", "inherit"]);
  });

  it("status prints a compact table without image digests or commands", () => {
    new DockerService("/tmp/test").status();
    const args = mockExecFileSync.mock.calls[0]![1] as string[];
    expect(args.slice(3)).toEqual(["ps", "--format", STATUS_TABLE_FORMAT]);
    expect(STATUS_TABLE_FORMAT).not.toMatch(/Image|Command/);
  });
});
