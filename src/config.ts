import * as fs from "node:fs";
import * as path from "node:path";
import type { EnvValues } from "./types.js";
import { success } from "./ui.js";

// ---------------------------------------------------------------------------
// Pure parsing utility (no class needed)
// ---------------------------------------------------------------------------

/** Parse a .env-style file into key-value pairs. */
export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    result[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return result;
}

/** Mode of .env on every write: it holds the Anthropic and Codex credentials. */
export const ENV_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// ConfigManager
// ---------------------------------------------------------------------------

/**
 * Manages .env configuration files for a Syntropic137 installation.
 *
 * Each instance is bound to a specific install directory.
 */
export class ConfigManager {
  private readonly envPath: string;

  constructor(private readonly installDir: string) {
    this.envPath = path.join(installDir, ".env");
  }

  /**
   * Read the .env template, substitute collected values, and write the final
   * .env file. Keys not present in the template are appended at the end.
   */
  writeEnv(values: EnvValues, templateDir: string): void {
    const templatePath = path.join(templateDir, "selfhost.env.example");
    let template = fs.readFileSync(templatePath, "utf-8");

    for (const [key, rawValue] of Object.entries(values)) {
      if (rawValue === undefined || rawValue === "") continue;
      const value = rawValue.replace(/[\r\n]/g, "");
      const regex = new RegExp(`^(${key})=.*$`, "m");
      if (regex.test(template)) {
        // A function replacement: a string one would expand `$&`, `$1` and
        // `$$` inside the value, silently rewriting passwords that contain `$`.
        template = template.replace(regex, () => `${key}=${value}`);
      } else {
        template += `\n${key}=${value}\n`;
      }
    }

    // .env holds credentials. writeFileSync applies `mode` only when it
    // creates the file, so an existing .env (hand-made, or an older install)
    // would keep a looser mode: tighten it BEFORE the new values land, and
    // again after, on every write.
    if (fs.existsSync(this.envPath)) fs.chmodSync(this.envPath, ENV_FILE_MODE);
    fs.writeFileSync(this.envPath, template, { mode: ENV_FILE_MODE });
    fs.chmodSync(this.envPath, ENV_FILE_MODE);
    success("Wrote .env");
  }

  /** Read the .env file into a key-value map. Returns {} if missing. */
  readEnv(): Record<string, string> {
    if (!fs.existsSync(this.envPath)) return {};
    return parseEnv(fs.readFileSync(this.envPath, "utf-8"));
  }

  /** Check if .env already exists. */
  exists(): boolean {
    return fs.existsSync(this.envPath);
  }
}

// ---------------------------------------------------------------------------
// Backward-compatible free functions
// ---------------------------------------------------------------------------

export function writeEnvFile(
  installDir: string,
  values: EnvValues,
  templateDir: string,
): void {
  new ConfigManager(installDir).writeEnv(values, templateDir);
}

export function readEnvFile(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) return {};
  return parseEnv(fs.readFileSync(envPath, "utf-8"));
}

export function envExists(installDir: string): boolean {
  return new ConfigManager(installDir).exists();
}
