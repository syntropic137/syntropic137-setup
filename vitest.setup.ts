import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

// No test may read this machine's Codex login (#92). The Codex step looks for
// `$CODEX_HOME/auth.json`, so every test run gets a CODEX_HOME that does not
// exist; tests that need a login create their own with invented values.
process.env.CODEX_HOME = path.join(os.tmpdir(), `s137-test-no-codex-home-${crypto.randomUUID()}`);
delete process.env.CODEX_AUTH_JSON;
