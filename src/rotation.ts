/**
 * Credential rotation for the three generated service secrets.
 *
 * Rotation was disabled (#56) because it wrote new secret files, restarted the
 * stack, and left every client presenting a password the SERVER had never
 * adopted. The stated reason for leaving it disabled was that this breaks the
 * system "with no safe recovery path". The first half is right. The second half
 * is not, and it is why this stayed off:
 *
 *   The postgres image ships `local all all trust` in pg_hba.conf, so
 *   `ALTER ROLE ... PASSWORD` over the container's own socket succeeds WITHOUT
 *   the old password. Recovery is always available, which means rollback can
 *   never be locked out by the failure it is recovering from.
 *
 * The other half of the original diagnosis was also right, and is the reason
 * this module exists rather than a loop over three files: each server adopts a
 * new credential by a DIFFERENT mechanism, measured 2026-09-07 against the
 * images this project actually pins.
 *
 *   postgres  the password lives in the database. POSTGRES_PASSWORD is honoured
 *             only at initdb; changing it and restarting leaves the server on
 *             the ORIGINAL password. Adoption requires ALTER ROLE.
 *   redis     requirepass is read from the secret file at start, and CONFIG SET
 *             changes it on a live server. Adoption can be immediate.
 *   minio     root credentials come from the environment at EVERY start and are
 *             not persisted. Adoption happens on recreate; the old password is
 *             rejected immediately afterwards.
 *
 * The invariant this module exists to hold:
 *
 *   A rotation is never reported as successful without authenticating to the
 *   service with the new value. Writing a file is not evidence. That gap is the
 *   whole defect: the disabled implementation changed files, reported success,
 *   and the mismatch surfaced at the next restart instead.
 */

import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Injected boundary
// ---------------------------------------------------------------------------

/**
 * Everything this module does to the outside world, in one interface, so the
 * ordering guarantees below can be tested without standing up real services.
 */
export interface RotationDeps {
  /** `docker compose exec -T <service> <argv...>`; returns stdout, throws non-zero. */
  exec(service: string, argv: string[], env?: Record<string, string>): string;
  /** `docker compose up -d <services...>` - recreate so new env and secrets are read. */
  recreate(services: readonly string[]): void;
  /** Current contents of a secret file, trimmed. */
  readSecret(file: string): string;
  /** Write a mounted secret file: mode 0644 inside the 0700 secrets dir (see secrets.ts). */
  writeSecret(file: string, value: string): void;
  /** Emit human-readable progress. */
  log(message: string): void;
}

/** Values read from the install's .env that the server commands need. */
export interface RotationConfig {
  postgresUser: string;
  postgresDb: string;
  /**
   * MinIO's root user. Read from configuration rather than assumed: the
   * compose file defaults MINIO_ROOT_USER to `minioadmin`, and an operator may
   * set it to anything. Hardcoding a name here made `mc alias set` fail with
   * "The Access Key Id you provided does not exist in our records" for BOTH the
   * new and the old password, so the rotation reported itself unrecoverable
   * while the server was untouched and healthy.
   */
  minioUser: string;
}

/** How a given server comes to accept a new credential. */
export type Adoption = "command" | "restart";

export interface CredentialSpec {
  /** Secret file name, as listed in SECRET_FILES. */
  readonly file: string;
  readonly label: string;
  /** The service that OWNS the credential and must accept it. */
  readonly server: string;
  /** Services that present the credential and must be recreated to pick it up. */
  readonly clients: readonly string[];
  readonly adoption: Adoption;
  /**
   * Make the server accept `next`. Only called when adoption is "command".
   * `previous` is supplied because some servers need it to authenticate the
   * change itself; postgres deliberately does not.
   */
  adopt?(d: RotationDeps, cfg: RotationConfig, next: string, previous: string): void;
  /**
   * Authenticate to the server with `value`. Throws if it is not accepted.
   * This must make a real authenticated call: the point is to catch a server
   * that never adopted the credential, so anything that could pass without
   * the server checking is worthless here.
   */
  verify(d: RotationDeps, cfg: RotationConfig, value: string): void;
}

// ---------------------------------------------------------------------------
// Value shape
// ---------------------------------------------------------------------------

/**
 * Generated secrets are 32 random bytes as hex. Enforced rather than assumed,
 * because these values are interpolated into a SQL statement and a shell argv
 * below; a value outside this alphabet has no legitimate source here.
 */
const SECRET_PATTERN = /^[0-9a-f]{64}$/;

export function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function assertRotatable(value: string, what: string): void {
  if (!SECRET_PATTERN.test(value)) {
    throw new Error(
      `${what} is not a 64-character hex secret. Refusing to use it: this value ` +
        `reaches a SQL statement and a command line, and nothing legitimate ` +
        `generates a different shape here.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The three credentials
// ---------------------------------------------------------------------------

const postgres: CredentialSpec = {
  file: "db-password.secret",
  label: "PostgreSQL",
  server: "timescaledb",
  clients: ["api", "event-store", "collector"],
  adoption: "command",

  adopt(d, cfg, next) {
    assertRotatable(next, "new PostgreSQL password");
    // Over the container's own socket, where pg_hba says `trust`. This is why
    // no old password is needed, and therefore why rollback cannot be locked out.
    d.exec("timescaledb", [
      "psql",
      "-U", cfg.postgresUser,
      "-d", cfg.postgresDb,
      "-v", "ON_ERROR_STOP=1",
      "-c", `ALTER ROLE ${quoteIdent(cfg.postgresUser)} PASSWORD '${next}'`,
    ]);
  },

  verify(d, cfg, value) {
    // -h forces a TCP connection, which routes through the `host ... scram-sha-256`
    // rule rather than the local `trust` rule. Connecting over the socket would
    // succeed with ANY password and prove nothing.
    const out = d.exec(
      "timescaledb",
      ["psql", "-h", "timescaledb", "-U", cfg.postgresUser, "-d", cfg.postgresDb,
        "-tAc", "select 1"],
      { PGPASSWORD: value },
    );
    if (out.trim() !== "1") {
      throw new Error(`PostgreSQL did not accept the new password (got: ${out.trim() || "no output"})`);
    }
  },
};

const redis: CredentialSpec = {
  file: "redis-password.secret",
  label: "Redis",
  server: "redis",
  clients: ["api"],
  adoption: "command",

  adopt(d, _cfg, next, previous) {
    assertRotatable(next, "new Redis password");
    // CONFIG SET changes requirepass on the live server. The secret file written
    // afterwards is what makes it survive the next restart.
    d.exec("redis", [
      "redis-cli", "-a", previous, "--no-auth-warning",
      "CONFIG", "SET", "requirepass", next,
    ]);
  },

  verify(d, _cfg, value) {
    const out = d.exec("redis", ["redis-cli", "-a", value, "--no-auth-warning", "PING"]);
    if (!out.includes("PONG")) {
      throw new Error(`Redis did not accept the new password (got: ${out.trim() || "no output"})`);
    }
  },
};

const minio: CredentialSpec = {
  file: "minio-password.secret",
  label: "MinIO",
  server: "minio",
  clients: ["api"],
  // Root credentials are read from the environment at every start and are not
  // persisted, so the server adopts on recreate. There is no command to issue,
  // and the file must therefore be written BEFORE the server is recreated.
  adoption: "restart",

  verify(d, cfg, value) {
    const out = d.exec("minio", [
      "mc", "alias", "set", "rotcheck", "http://localhost:9000", cfg.minioUser, value,
    ]);
    if (!/successfully/i.test(out)) {
      throw new Error(`MinIO did not accept the new password (got: ${out.trim() || "no output"})`);
    }
  },
};

export const CREDENTIALS: readonly CredentialSpec[] = [postgres, redis, minio];

/** Double-quote a SQL identifier. Role names are operator-supplied via .env. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export interface RotationOutcome {
  label: string;
  file: string;
  status: "rotated" | "rolled-back" | "skipped";
  error?: string;
}

/**
 * Rotate one credential, verifying against the service and rolling back on any
 * failure. The ordering is the safety property:
 *
 *   command adoption  server first, then the file, then the clients
 *   restart adoption  file first (the server reads it), then server + clients
 *
 * Either way the file is only left in place once the server has been proven to
 * accept its contents.
 */
export function rotateOne(
  d: RotationDeps,
  cfg: RotationConfig,
  spec: CredentialSpec,
): RotationOutcome {
  const previous = d.readSecret(spec.file);
  const next = generateSecret();

  // Undo only what actually happened. If the server refused to adopt, nothing
  // changed and there is nothing to reverse; re-issuing the adopt command in
  // that state just fails a second time and buries the real error under a
  // compound one.
  let serverAdopted = false;
  let fileWritten = false;

  try {
    if (spec.adoption === "command") {
      d.log(`  ${spec.label}: asking the server to adopt the new credential`);
      spec.adopt?.(d, cfg, next, previous);
      serverAdopted = true;
      d.writeSecret(spec.file, next);
      fileWritten = true;
      d.recreate(spec.clients);
    } else {
      d.log(`  ${spec.label}: writing the secret, then recreating so the server reads it`);
      d.writeSecret(spec.file, next);
      fileWritten = true;
      d.recreate([spec.server, ...spec.clients]);
      serverAdopted = true;
    }

    d.log(`  ${spec.label}: verifying against the service`);
    spec.verify(d, cfg, next);

    return { label: spec.label, file: spec.file, status: "rotated" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    if (!serverAdopted && !fileWritten) {
      // Nothing was changed, so this is a clean refusal rather than a rollback.
      d.log(`  ${spec.label}: refused before anything changed (${reason})`);
      return { label: spec.label, file: spec.file, status: "rolled-back", error: reason };
    }

    d.log(`  ${spec.label}: FAILED, rolling back (${reason})`);
    try {
      rollbackOne(d, cfg, spec, previous, { serverAdopted, fileWritten });
      return { label: spec.label, file: spec.file, status: "rolled-back", error: reason };
    } catch (rollbackErr) {
      const rb = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new Error(
        `${spec.label} rotation failed AND rollback failed.\n` +
          `  rotation: ${reason}\n  rollback: ${rb}\n` +
          `  The previous value is ${previous.slice(0, 4)}... in the backup alongside ${spec.file}.`,
      );
    }
  }
}

/** What a partially-completed rotation actually changed. */
export interface RotationProgress {
  serverAdopted: boolean;
  fileWritten: boolean;
}

/**
 * Put a credential back the way it was, reversing only the steps that ran.
 * Ends by authenticating with the restored value, because "we wrote the old
 * value back" is the same kind of unverified claim this module exists to stop.
 */
export function rollbackOne(
  d: RotationDeps,
  cfg: RotationConfig,
  spec: CredentialSpec,
  previous: string,
  progress: RotationProgress = { serverAdopted: true, fileWritten: true },
): void {
  if (spec.adoption === "command") {
    if (progress.serverAdopted) spec.adopt?.(d, cfg, previous, d.readSecret(spec.file));
    if (progress.fileWritten) d.writeSecret(spec.file, previous);
    d.recreate(spec.clients);
  } else {
    if (progress.fileWritten) d.writeSecret(spec.file, previous);
    d.recreate([spec.server, ...spec.clients]);
  }
  spec.verify(d, cfg, previous);
}

/** Rotate every credential in order, stopping at the first that cannot be recovered. */
export function rotateAll(
  d: RotationDeps,
  cfg: RotationConfig,
  specs: readonly CredentialSpec[] = CREDENTIALS,
): RotationOutcome[] {
  const results: RotationOutcome[] = [];
  for (const spec of specs) {
    results.push(rotateOne(d, cfg, spec));
  }
  return results;
}
