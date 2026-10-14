import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { success, info } from "./ui.js";
import {
  SECRET_FILES,
  PEM_FILE,
  WEBHOOK_SECRET_FILE,
  CLIENT_SECRET_FILE,
} from "./constants.js";

/**
 * Manages cryptographic secrets for a Syntropic137 installation.
 *
 * Each instance is bound to a specific secrets directory and provides
 * methods to generate, save, and back up secret files.
 */
/**
 * Mode of a secret file the containers read. Compose `file:` secrets are bind
 * mounts that keep the host file's owner and mode, and the consumers are not
 * root: minio runs as 999:999 and the collector drops capabilities. A 0600
 * file owned by the installing user is therefore unreadable inside them and a
 * fresh install never becomes healthy (issue #78). Host-side secrecy comes
 * from the directory, which is 0700, so no other host user can reach the
 * files at all.
 */
export const CONTAINER_READABLE_MODE = 0o644;
export const SECRETS_DIR_MODE = 0o700;

export class SecretsManager {
  constructor(private readonly secretsDir: string) {}

  /**
   * Generate cryptographically random secret files.
   * Each file contains a 32-byte hex string (64 chars), mode 0644 inside a 0700 directory (see CONTAINER_READABLE_MODE).
   *
   * @param force — regenerate all secrets even if they exist;
   *                old values are backed up to `<name>.bak`.
   */
  generate(force = false): void {
    fs.mkdirSync(this.secretsDir, { recursive: true, mode: SECRETS_DIR_MODE });
    fs.chmodSync(this.secretsDir, SECRETS_DIR_MODE); // mkdir honours the umask; the directory is the boundary

    for (const filename of SECRET_FILES) {
      const filePath = path.join(this.secretsDir, filename);
      if (fs.existsSync(filePath)) {
        if (!force) {
          info(`  ${filename} already exists, skipping`);
          continue;
        }
        const bakPath = filePath + ".bak";
        fs.copyFileSync(filePath, bakPath);
        fs.chmodSync(bakPath, 0o600);
        info(`  Backed up ${filename} → ${filename}.bak`);
      }
      const secret = crypto.randomBytes(32).toString("hex");
      fs.writeFileSync(filePath, secret, { mode: CONTAINER_READABLE_MODE });
      fs.chmodSync(filePath, CONTAINER_READABLE_MODE); // writeFileSync keeps an existing file's old mode
      success(`Generated ${filename}`);
    }

    // Create empty PEM placeholder so Docker secrets don't fail
    const pemPath = path.join(this.secretsDir, PEM_FILE);
    if (!fs.existsSync(pemPath)) {
      fs.writeFileSync(pemPath, "", { mode: CONTAINER_READABLE_MODE });
    }
    // Explicit modes, independent of the umask and of files kept from an
    // earlier install (1.0.1 and older wrote them 0600).
    normalizeSecretPermissions(this.secretsDir);
  }

  /** Save a GitHub App private key PEM file. Returns the file path. */
  savePem(pem: string): string {
    const pemPath = path.join(this.secretsDir, PEM_FILE);
    fs.writeFileSync(pemPath, pem, { mode: CONTAINER_READABLE_MODE });
    fs.chmodSync(pemPath, CONTAINER_READABLE_MODE);
    success(`Saved ${PEM_FILE}`);
    return pemPath;
  }

  /** Save a webhook secret to a text file. */
  saveWebhookSecret(secret: string): void {
    const filePath = path.join(this.secretsDir, WEBHOOK_SECRET_FILE);
    fs.writeFileSync(filePath, secret, { mode: 0o600 });
  }

  /** Save a client secret to a text file. */
  saveClientSecret(secret: string): void {
    const filePath = path.join(this.secretsDir, CLIENT_SECRET_FILE);
    fs.writeFileSync(filePath, secret, { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------
// Permission invariant for the secrets the containers read
// ---------------------------------------------------------------------------

/** The secret files compose mounts into containers. */
export const MOUNTED_SECRET_FILES: readonly string[] = [...SECRET_FILES, PEM_FILE];

/**
 * Enforce the invariant: secrets dir 0700, every mounted secret file that
 * exists 0644. Contents are never touched. Run before the stack starts, so an
 * install made by 1.0.1 or older (files 0600) becomes readable by the non-root
 * containers. No-op when the directory does not exist.
 */
export function normalizeSecretPermissions(secretsDir: string): void {
  if (!fs.existsSync(secretsDir)) return;
  fs.chmodSync(secretsDir, SECRETS_DIR_MODE);
  for (const file of MOUNTED_SECRET_FILES) {
    const p = path.join(secretsDir, file);
    if (fs.existsSync(p)) fs.chmodSync(p, CONTAINER_READABLE_MODE);
  }
}

/**
 * Write a mounted secret file (rotation and rollback). Mode is set explicitly
 * because writeFileSync keeps an existing file's old mode, and the directory
 * is re-secured because it is the host-side boundary.
 */
export function writeMountedSecret(secretsDir: string, file: string, value: string): void {
  fs.chmodSync(secretsDir, SECRETS_DIR_MODE);
  const target = path.join(secretsDir, file);
  fs.writeFileSync(target, value, { mode: CONTAINER_READABLE_MODE });
  fs.chmodSync(target, CONTAINER_READABLE_MODE);
}

// ---------------------------------------------------------------------------
// Backward-compatible free functions (delegate to a one-off instance)
// ---------------------------------------------------------------------------

export function generateSecrets(secretsDir: string, force = false): void {
  new SecretsManager(secretsDir).generate(force);
}

export function savePem(secretsDir: string, pem: string): string {
  return new SecretsManager(secretsDir).savePem(pem);
}

export function saveWebhookSecret(secretsDir: string, secret: string): void {
  new SecretsManager(secretsDir).saveWebhookSecret(secret);
}

export function saveClientSecret(secretsDir: string, secret: string): void {
  new SecretsManager(secretsDir).saveClientSecret(secret);
}
