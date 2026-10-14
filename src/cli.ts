#!/usr/bin/env node

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { CliOptions, EnvValues, SkillsAction } from "./types.js";
import {
  banner,
  setupOverview,
  summaryBox,
  step,
  info,
  success,
  fail,
  warn,
  bold,
  cyan,
  dim,
  prompt,
  promptSecret,
  confirm,
  setTotalSteps,
  interactiveMenu,
} from "./ui.js";
import type { MenuItem } from "./ui.js";
import { checkDocker, DockerService } from "./docker.js";
import { SecretsManager } from "./secrets.js";
import {
  CREDENTIALS,
  rollbackOne,
  rotateAll,
  type RotationConfig,
  type RotationDeps,
} from "./rotation.js";
import { ConfigManager } from "./config.js";
import { GitHubAppSetup, openBrowser } from "./manifest.js";
import {
  DEFAULT_INSTALL_DIR,
  DEFAULT_APP_NAME,
  DEFAULT_PORT,
  DEFAULT_APP_ENVIRONMENT,
  DEFAULT_API_USER,
  COMPOSE_FILE,
  TEMPLATE_FILES,
  ENV_KEYS,
  CMD,
  BIN,
  COMMANDS,
  GITHUB_BASE,
  GITHUB_SLUG_RE,
} from "./constants.js";
import { PKG_DIR, TEMPLATES_DIR, syncTemplate } from "./templates.js";
import { SkillsManager, defaultRunner, skillsRemoveArgs } from "./skills.js";
import {
  ResetRefusal,
  defaultSyncRunner,
  executeReset,
  executionBlocker,
  planReset,
  printGithubAppNote,
  printPlan,
  printResults,
  type ResetPlan,
} from "./reset.js";

// ---------------------------------------------------------------------------
// Version & paths
// ---------------------------------------------------------------------------

const _pkg = JSON.parse(
  fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf-8"),
);
const VERSION = _pkg.version as string;
const PLATFORM_VERSION: string = _pkg.syntropic137?.platformVersion ?? VERSION;

// ---------------------------------------------------------------------------
// InitFlow — orchestrates the 10-step first-run setup
// ---------------------------------------------------------------------------

export class InitFlow {
  private readonly installDir: string;
  private readonly secretsDir: string;
  private readonly appName: string;
  private readonly config: ConfigManager;
  private readonly secrets: SecretsManager;

  constructor(private readonly opts: CliOptions) {
    this.installDir = path.resolve(opts.dir || DEFAULT_INSTALL_DIR);
    this.secretsDir = path.join(this.installDir, "secrets");
    this.appName = opts.name || DEFAULT_APP_NAME;
    this.config = new ConfigManager(this.installDir);
    this.secrets = new SecretsManager(this.secretsDir);
  }

  async run(): Promise<void> {
    let steps = 12;
    if (this.opts.skipGithub) steps -= 1;
    if (this.opts.skipDocker) steps -= 3;
    setTotalSteps(steps);

    // ── Pre-setup overview ─────────────────────────────────────────────
    setupOverview({
      skipGithub: this.opts.skipGithub ?? false,
      skipDocker: this.opts.skipDocker ?? false,
    });

    // Re-run safety: detect existing .env
    let reconfigure = false;
    if (this.config.exists()) {
      warn("Existing installation detected at " + this.installDir);
      const proceed = await confirm("Reconfigure from scratch?", false);
      if (!proceed) {
        if (this.opts.skipDocker) {
          info(`Docker steps skipped (--skip-docker). Run \`${CMD.start}\` to start the stack manually.`);
        } else {
          // Offer to just bring the stack up from existing config
          const startStack = await confirm("Start the stack from existing config?", true);
          if (startStack) {
            checkDocker();
            try {
              const docker = new DockerService(this.installDir);
              docker.start();
              await docker.waitForHealth();
            } catch (err) {
              warn("Could not start the stack.");
              if (err instanceof Error) info(err.message);
              info(`Restart manually: ${CMD.start}`);
            }
          } else {
            info(`Run \`${CMD.start}\` to start the stack, or \`${CMD.status}\` to check health.`);
          }
        }
        return;
      }
      reconfigure = true;

      // Tear down the old stack (including volumes) so the DB reinitializes
      // with fresh secrets. Old secrets are backed up to .bak files.
      if (!this.opts.skipDocker) {
        info("Stopping existing stack and removing volumes...");
        try {
          new DockerService(this.installDir).downWithVolumes();
          success("Old stack torn down");
        } catch {
          warn("Could not tear down old stack (may not be running). Continuing...");
        }
      }
    }

    // ── Step 1: Check Docker ────────────────────────────────────────────
    step("Checking Docker");
    if (!this.opts.skipDocker) {
      checkDocker();
    } else {
      info("Skipped (--skip-docker)");
    }

    // ── Step 2: Create directories ──────────────────────────────────────
    step("Creating install directory");
    fs.mkdirSync(this.installDir, { recursive: true });
    fs.mkdirSync(path.join(this.installDir, "init-db"), { recursive: true });
    fs.mkdirSync(path.join(this.installDir, "workspaces"), { recursive: true });
    success(this.installDir);

    // ── Step 3: Copy templates ──────────────────────────────────────────
    step("Copying templates");
    for (const tpl of TEMPLATE_FILES) {
      this.copyTemplate(tpl);
    }
    fs.chmodSync(path.join(this.installDir, "selfhost-entrypoint.sh"), 0o755);
    success("Templates copied");

    // ── Step 4: Generate secrets ────────────────────────────────────────
    step("Generating secrets");
    this.secrets.generate(reconfigure);
    // Generate gateway auth password — required for all deployments.
    // Do not wrap in try/catch: if crypto fails, propagate immediately.
    const apiPassword = crypto.randomBytes(32).toString("hex");

    // ── Step 5: Prompt for API key ──────────────────────────────────────
    step("Configuring LLM provider");
    const envValues: EnvValues = {
      [ENV_KEYS.APP_ENVIRONMENT]: DEFAULT_APP_ENVIRONMENT,
      [ENV_KEYS.SYN_VERSION]: PLATFORM_VERSION,
      [ENV_KEYS.SYN_INSTALL_DIR]: this.installDir,
      [ENV_KEYS.SYN_API_USER]: DEFAULT_API_USER,
      [ENV_KEYS.SYN_API_PASSWORD]: apiPassword,
    };

    const existingKey = process.env.ANTHROPIC_API_KEY || "";
    const existingOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN || "";

    // Try to use what's already in the environment first. If found but malformed,
    // warn AND fall through to the interactive prompt so the user can correct it
    // during init rather than ending with no credential at all.
    let routedFromEnv: { envKey: string; value: string } | null = null;
    if (existingOauth) {
      routedFromEnv = routeAnthropicCredential(existingOauth);
      if (!routedFromEnv) {
        warn("CLAUDE_CODE_OAUTH_TOKEN in environment does not look like a valid Anthropic credential; will prompt instead.");
      }
    } else if (existingKey) {
      // Prefix-detect what was actually exported. A user who exported their
      // Anthropic credential as ANTHROPIC_API_KEY may have pasted any token
      // type into that variable; route it to the correct field by prefix.
      routedFromEnv = routeAnthropicCredential(existingKey);
      if (!routedFromEnv) {
        warn("ANTHROPIC_API_KEY in environment does not look like a valid Anthropic credential; will prompt instead.");
      }
    }

    if (routedFromEnv) {
      info("Found credentials in environment");
      envValues[routedFromEnv.envKey] = routedFromEnv.value;
    } else {
      // Neutral prompt copy: do not name the credential type. Accept whatever
      // the user pastes, then prefix-detect to route it to the correct env
      // var. See ADR-024 (platform repo) for why this matters: Claude Code CLI
      // requires the credential under the matching env var name; routing it
      // to the wrong field silently breaks every workflow run.
      info("Anthropic credentials are required to run agents.");
      info("Paste your Anthropic credential below.");
      info("Get a credential at: https://console.anthropic.com/settings/keys");
      const raw = await promptSecret("Anthropic credential");
      const credential = raw.trim();
      if (!credential) {
        warn("No credential provided. You can add it to .env later.");
      } else {
        const routed = routeAnthropicCredential(credential);
        if (routed) {
          envValues[routed.envKey] = routed.value;
          info(`Credential stored as ${routed.envKey}.`);
        } else {
          warn("Credential does not look like a valid Anthropic token (expected sk-ant-… prefix). Skipping; you can add it to .env manually later.");
        }
      }
    }

    // ── Step 6: GitHub App Manifest flow ────────────────────────────────
    if (!this.opts.skipGithub) {
      step("Setting up GitHub App");
      console.log();
      info("This creates a GitHub App so Syntropic137 can interact with your repos.");
      info("Make sure you are logged in to GitHub before clicking Create.");
      info("A browser window will open — approve the app, then return here.");
      console.log();

      const proceed = await confirm("Create a GitHub App now?");
      if (proceed) {
        // Determine org scope
        let org = this.opts.org;
        if (!org) {
          const orgAnswer = await prompt(
            "GitHub org name (leave empty for personal account)",
          );
          if (orgAnswer) org = orgAnswer;
        }

        try {
          const setup = new GitHubAppSetup({
            appName: this.appName,
            webhookUrl: this.opts.webhookUrl,
            secretsDir: this.secretsDir,
            org,
          });
          const result = await setup.run();

          envValues[ENV_KEYS.SYN_GITHUB_APP_ID] = String(result.id);
          envValues[ENV_KEYS.SYN_GITHUB_APP_NAME] = result.slug;
          if (org) {
            envValues[ENV_KEYS.SYN_GITHUB_APP_ORG] = org;
          }
          if (result.webhook_secret) {
            envValues[ENV_KEYS.SYN_GITHUB_WEBHOOK_SECRET] = result.webhook_secret;
          }
        } catch (err) {
          fail("GitHub App creation failed.");
          if (err instanceof Error) info(err.message);
          info(`You can set up GitHub integration later with \`${CMD.skipDocker}\`.`);
        }
      } else {
        info("Skipped. You can create a GitHub App later.");
      }
    }

    // ── Step 7: Agent skills (Claude Code + Codex) ──────────────────────
    step("Agent skills");
    const skillsInstalled = await this.installSkills();

    // ── Step 8: Syntropic137 CLI ─────────────────────────────────────────
    step("Syntropic137 CLI");
    await this.installCli();

    // ── Step 9: Write .env ──────────────────────────────────────────────
    step("Writing configuration");
    this.config.writeEnv(envValues, TEMPLATES_DIR);

    if (this.opts.skipDocker) {
      console.log();
      success("Templates written to " + this.installDir);
      info(`Run \`cd ${this.installDir} && docker compose -f ${COMPOSE_FILE} up -d\` to start.`);
      return;
    }

    // ── Steps 10–12: Docker ──────────────────────────────────────────────
    const docker = new DockerService(this.installDir);

    step("Pulling container images");
    docker.pull();

    step("Starting services");
    docker.up();

    step("Health check");
    const port = envValues[ENV_KEYS.SYN_GATEWAY_PORT] || DEFAULT_PORT;
    const healthy = await docker.waitForHealth(port);

    // ── Summary ─────────────────────────────────────────────────────────
    summaryBox({ healthy, port, installDir: this.installDir, showCredentials: true, skillsInstalled });
  }

  // ── Private ───────────────────────────────────────────────────────────

  private copyTemplate(relativePath: string): void {
    syncTemplate(TEMPLATES_DIR, this.installDir, relativePath);
  }

  private async installCli(): Promise<void> {
    if (!process.stdout.isTTY) return; // Skip in non-interactive/CI environments

    const targetRange = `~${PLATFORM_VERSION}`; // same major.minor, patch >= platform
    const installed = InitFlow.getInstalledCliVersion();

    if (installed) {
      // Version compatibility: major.minor must match; patch drift is allowed.
      // The NPX CLI can independently bump patch versions between platform releases.
      // Only major.minor alignment is enforced — see version-invariant docs.
      const [iMajor, iMinor] = installed.split(".").map(Number);
      const [pMajor, pMinor] = PLATFORM_VERSION.split(".").map(Number);
      if (iMajor === pMajor && iMinor === pMinor) {
        success(`syn CLI ${installed} (matches platform ${PLATFORM_VERSION})`);
        return;
      }
      warn(`syn CLI ${installed} does not match platform ${PLATFORM_VERSION}`);
      const proceed = await confirm(`Update to @syntropic137/cli@${targetRange}?`);
      if (!proceed) { info("Skipped."); return; }
    } else {
      info("The syn CLI lets you manage workflows, triggers, and executions.");
      const proceed = await confirm(`Install @syntropic137/cli@${targetRange}? (recommended)`);
      if (!proceed) {
        info("Skipped. Install later: npm install -g @syntropic137/cli");
        return;
      }
    }

    try {
      execFileSync("npm", ["install", "-g", `@syntropic137/cli@${targetRange}`], { stdio: "pipe" });
      success("syn CLI installed");
    } catch (err) {
      warn("Could not install syn CLI.");
      if (err instanceof Error) info(err.message);
      info(`Install manually: npm install -g @syntropic137/cli@${targetRange}`);
    }
  }

  /** Get installed syn CLI version, or null if not found. */
  static getInstalledCliVersion(): string | null {
    try {
      const output = execFileSync("syn", ["version"], {
        encoding: "utf-8",
        stdio: "pipe",
      });
      // Expected output like "0.19.7" or "syn-cli 0.19.7"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /** Returns true when the skills ended up installed. Never fails the setup. */
  private async installSkills(): Promise<boolean> {
    info("Teaches Claude Code and Codex to drive Syntropic137 (workflows, runs, sessions).");
    if (!this.opts.yes) {
      if (!isInteractive()) {
        // No terminal to ask in: global installs need explicit consent (--yes).
        info(`Skipped (non-interactive). Install later: ${CMD.skills}`);
        return false;
      }
      const proceed = await confirm("Install the Syntropic137 agent skills? (recommended)");
      if (!proceed) {
        info("Skipped. Install later: " + CMD.skills);
        return false;
      }
    }
    // Problems surface as a warning and the manual command, never an exception.
    try {
      return (await newSkillsManager(this.opts).install()) === "installed";
    } catch (err) {
      warn("Could not install the Syntropic137 agent skills.");
      if (err instanceof Error) info(err.message);
      info(`Install later: ${CMD.skills}`);
      return false;
    }
  }
}

/** True when we can prompt the user. */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function newSkillsManager(opts: CliOptions): SkillsManager {
  return new SkillsManager({
    run: defaultRunner,
    confirm,
    interactive: isInteractive(),
    assumeYes: opts.yes ?? false,
  });
}

// ---------------------------------------------------------------------------
// CLI — arg parsing and command routing
// ---------------------------------------------------------------------------

export class CLI {
  private readonly opts: CliOptions;

  constructor(argv: string[]) {
    this.opts = CLI.parseArgs(argv);
  }

  async run(): Promise<void> {
    let command = this.opts.command;

    const fromMenu = command === "menu";
    if (fromMenu) {
      command = await this.showMenu();
    }

    // Show banner on direct CLI invocations (menu already shows its own)
    if (!fromMenu) {
      banner(PLATFORM_VERSION);
    }

    const dir = this.opts.dir || DEFAULT_INSTALL_DIR;

    switch (command) {
      case "init":
        await new InitFlow(this.opts).run();
        break;

      case "status":
        new DockerService(this.resolveDir(dir)).status();
        console.log();
        await newSkillsManager(this.opts).summary();
        break;

      case "stop":
        new DockerService(this.resolveDir(dir)).stop();
        break;

      case "start":
        new DockerService(this.resolveDir(dir)).start();
        break;

      case "logs":
        new DockerService(this.resolveDir(dir)).logs();
        break;

      case "update":
        new DockerService(this.resolveDir(dir)).update(TEMPLATES_DIR);
        break;

      case "plugin":
        warn(`\`${BIN} plugin\` is deprecated: the Claude Code plugin was replaced by agent skills.`);
        info(`Running \`${CMD.skills}\` instead.`);
        await this.skills("install");
        break;

      case "skills":
        await this.skills(this.opts.skillsAction ?? "install");
        break;

      case "github-app":
        await this.githubApp(dir);
        break;

      case "tunnel":
        await this.tunnel(dir);
        break;

      case "cli":
        CLI.cliSync();
        break;

      case "credentials":
        await this.credentials(dir, this.opts.credentialsAction);
        break;

      case "reset":
        await this.reset(dir);
        break;
    }
  }

  private static cliSync(): void {
    const targetRange = `~${PLATFORM_VERSION}`;
    const installed = InitFlow.getInstalledCliVersion();

    if (installed) {
      // Major.minor compatibility only — patch drift is expected because the
      // NPX package may publish patch bumps independently of platform releases.
      // See version-invariant docs for the full policy.
      const [iMajor, iMinor] = installed.split(".").map(Number);
      const [pMajor, pMinor] = PLATFORM_VERSION.split(".").map(Number);
      if (iMajor === pMajor && iMinor === pMinor) {
        success(`syn CLI ${installed} (compatible with platform ${PLATFORM_VERSION})`);
        return;
      }
      warn(`syn CLI ${installed} is not compatible with platform ${PLATFORM_VERSION}`);
    }

    info(`Installing @syntropic137/cli@${targetRange}...`);
    try {
      execFileSync("npm", ["install", "-g", `@syntropic137/cli@${targetRange}`], { stdio: "pipe" });
      success("syn CLI installed");
    } catch (err) {
      fail("Could not install syn CLI.");
      if (err instanceof Error) info(err.message);
      const execErr = err as { stderr?: Buffer | string; stdout?: Buffer | string };
      const stderr = execErr.stderr?.toString().trim();
      const stdout = execErr.stdout?.toString().trim();
      if (stderr) info(stderr);
      if (stdout) info(stdout);
      info(`Install manually: npm install -g @syntropic137/cli@${targetRange}`);
      process.exit(1);
    }
  }

  private async skills(action: SkillsAction): Promise<void> {
    const manager = newSkillsManager(this.opts);
    if (action === "status") {
      const ok = await manager.status();
      if (!ok) process.exitCode = 1;
      return;
    }
    // `update` re-runs the install: it refreshes every skill from the source
    // and also picks up skills added upstream since the last install.
    const outcome = await manager.install();
    if (outcome !== "installed") process.exitCode = 1;
  }

  // ── Factory reset ────────────────────────────────────────────────────

  private async reset(dir: string): Promise<void> {
    const execute = this.opts.yes ?? false;
    let plan: ResetPlan;
    try {
      plan = await planReset(
        {
          installDir: dir,
          backup: !this.opts.noBackup,
          images: this.opts.images ?? false,
          cli: this.opts.cli ?? false,
          skills: this.opts.skills ?? false,
        },
        {
          run: defaultSyncRunner,
          listSkills: async () => {
            const installed = await newSkillsManager(this.opts).listInstalled();
            return installed ? installed.map((s) => s.name) : null;
          },
          homedir: os.homedir(),
          now: new Date(),
        },
      );
    } catch (err) {
      if (err instanceof ResetRefusal) {
        fail(err.message);
        process.exit(1);
      }
      throw err;
    }

    printPlan(plan, execute);
    const blocker = execute ? executionBlocker(plan) : null;
    if (blocker) {
      console.log();
      fail(blocker);
      info("Nothing was removed.");
      process.exit(1);
    }
    if (!execute) {
      printGithubAppNote(plan);
      console.log();
      info(`Dry run: nothing was removed. Re-run with ${bold("--yes")} to reset.`);
      return;
    }

    console.log();
    const results = await executeReset(plan, {
      run: defaultSyncRunner,
      removeSkills: (names) => defaultRunner("npx", skillsRemoveArgs(names), 600_000),
    });
    const ok = printResults(results, plan);
    printGithubAppNote(plan);
    if (!ok) process.exitCode = 1;
  }

  // ── GitHub App management ────────────────────────────────────────────

  private async githubApp(dir: string): Promise<void> {
    const installDir = this.resolveDir(dir);
    const config = new ConfigManager(installDir);
    const env = config.readEnv();
    const slug = env[ENV_KEYS.SYN_GITHUB_APP_NAME];

    if (!slug) {
      fail("No GitHub App configured.");
      info(`Run \`${CMD.init}\` to create one, or set ${ENV_KEYS.SYN_GITHUB_APP_NAME} in .env.`);
      process.exit(1);
    }

    if (!GITHUB_SLUG_RE.test(slug)) {
      fail(`Invalid GitHub App slug: ${slug}`);
      process.exit(1);
    }

    const org = this.opts.org || env[ENV_KEYS.SYN_GITHUB_APP_ORG];
    if (org && !GITHUB_SLUG_RE.test(org)) {
      fail(`Invalid GitHub org name: ${org}`);
      process.exit(1);
    }

    const settingsBase = org
      ? `${GITHUB_BASE}/organizations/${org}/settings/apps/${slug}`
      : `${GITHUB_BASE}/settings/apps/${slug}`;
    const pages: MenuItem[] = [
      { label: "General settings",  value: settingsBase,                  description: "Logo, name, description, callback URLs" },
      { label: "Permissions",       value: `${settingsBase}/permissions`, description: "Repository and org permissions" },
      { label: "Installations",     value: `${GITHUB_BASE}/apps/${slug}/installations/new`, description: "Add or manage repo access" },
    ];

    info(`GitHub App: ${bold(slug)}`);
    console.log();

    const url = await interactiveMenu(pages, "What would you like to open?");
    console.log();
    info(`Opening ${cyan(url)}`);
    openBrowser(url);
  }

  // ── Tunnel setup ─────────────────────────────────────────────────────

  private async tunnel(dir: string): Promise<void> {
    const installDir = this.resolveDir(dir);
    const config = new ConfigManager(installDir);

    // ── Security gate: require gateway password before internet exposure ─
    const existingEnv = config.readEnv();
    const existingPassword = existingEnv[ENV_KEYS.SYN_API_PASSWORD];
    if (!existingPassword || existingPassword.trim() === "") {
      fail(`${ENV_KEYS.SYN_API_PASSWORD} is not set — the tunnel would expose your API without authentication.`);
      info(`Run: ${CMD["credentials"]} rotate to generate credentials first.`);
      process.exit(1);
    }

    console.log();
    info(bold("Remote Access Setup"));
    console.log();
    info("A tunnel exposes your local Syntropic137 instance to the internet,");
    info("enabling GitHub webhooks and full event coverage (60+ event types).");
    info(`Without a tunnel, only ${bold("17")} event types work (via polling).`);
    console.log();

    const providers: MenuItem[] = [
      {
        label: "Cloudflare Tunnel",
        value: "cloudflare",
        description: "Free, production-ready (recommended)",
      },
      {
        label: "Tailscale Funnel",
        value: "tailscale",
        description: "Coming soon",
      },
      {
        label: "ngrok",
        value: "ngrok",
        description: "Coming soon",
      },
    ];

    const provider = await interactiveMenu(providers, "Choose a tunnel provider:");
    console.log();

    if (provider !== "cloudflare") {
      info(`${bold(providers.find((p) => p.value === provider)!.label)} support is not yet available.`);
      info("Track progress at the linked GitHub issue.");
      info(`In the meantime, use ${cyan("Cloudflare Tunnel")} (free tier available).`);
      return;
    }

    // ── Cloudflare Tunnel flow ──────────────────────────────────────────
    info(bold("Cloudflare Tunnel Setup"));
    console.log();
    info("Prerequisites:");
    info("  1. A Cloudflare account (free tier works)");
    info("  2. A domain added to Cloudflare DNS");
    info("  3. A tunnel created via the Cloudflare dashboard or CLI");
    console.log();
    info("Create a tunnel: https://one.dash.cloudflare.com → Networks → Tunnels");
    info(`Point it to: ${cyan("http://gateway:8081")}  ${dim("(auth-guarded nginx port — reachable from cloudflared on the Docker network)")}`);
    info(`${dim("  Do NOT use port 80 or 8137 — those are unauthenticated.")}`);
    console.log();

    const token = await promptSecret("Cloudflare Tunnel token");
    if (!token) {
      warn("No token provided. You can set CLOUDFLARE_TUNNEL_TOKEN in .env later.");
      return;
    }

    const hostname = await prompt("Public hostname (e.g. syn.example.com)");
    if (!hostname) {
      warn("No hostname provided. You can set SYN_PUBLIC_HOSTNAME in .env later.");
      return;
    }

    // Read existing .env values, merge tunnel config, and rewrite
    const env = config.readEnv();
    const existingProfiles = (env[ENV_KEYS.COMPOSE_PROFILES] ?? "").split(",").map(s => s.trim()).filter(Boolean);
    if (!existingProfiles.includes("tunnel")) existingProfiles.push("tunnel");
    env[ENV_KEYS.COMPOSE_PROFILES] = existingProfiles.join(",");
    env[ENV_KEYS.CLOUDFLARE_TUNNEL_TOKEN] = token;
    env[ENV_KEYS.SYN_PUBLIC_HOSTNAME] = hostname;
    config.writeEnv(env as EnvValues, TEMPLATES_DIR);

    console.log();
    success("Tunnel configuration saved");
    info(`  COMPOSE_PROFILES=tunnel`);
    info(`  SYN_PUBLIC_HOSTNAME=${hostname}`);
    console.log();

    // Offer to restart the stack so the tunnel container starts
    const restart = await confirm("Restart the stack now to activate the tunnel?");
    if (restart) {
      try {
        const docker = new DockerService(installDir);
        docker.stop();
        docker.start();
        success("Stack restarted with tunnel enabled");
      } catch (err) {
        warn("Could not restart the stack.");
        if (err instanceof Error) info(err.message);
        info(`Restart manually: ${CMD.start}`);
      }
    } else {
      info(`Restart when ready: ${CMD.start}`);
    }

    console.log();
    info(bold("Next steps:"));
    info(`  1. Verify the tunnel: open ${cyan(`https://${hostname}`)}`);
    info(`  2. Update your GitHub App webhook URL to ${cyan(`https://${hostname}/api/v1/github/webhooks`)}`);
    info(`  3. Run ${cyan(CMD["github-app"])} to open GitHub App settings`);
  }

  // ── Credentials management ───────────────────────────────────────────

  private async credentials(dir: string, action?: "show" | "rotate" | "rollback"): Promise<void> {
    const installDir = this.resolveDir(dir);

    // If no action provided, show a sub-menu
    if (!action) {
      const items: MenuItem[] = [
        { label: "show",     value: "show",     description: "View access instructions and copy commands" },
        { label: "rotate",   value: "rotate",   description: "Generate new service credentials, verified against each service" },
        { label: "rollback", value: "rollback", description: "Restore credentials from the last backup" },
      ];
      action = (await interactiveMenu(items, "What would you like to do?")) as "show" | "rotate" | "rollback";
      console.log();
    }

    if (action === "show") {
      this.credentialsShow(installDir);
      return;
    }

    if (action === "rollback") {
      await this.credentialsRollback(installDir);
      return;
    }

    await this.credentialsRotate(installDir);
  }

  /**
   * Everything the rotation touches outside this process, in one place.
   *
   * Shared by rotate and rollback deliberately: they must reach docker the same
   * way, or a rollback can fail for reasons the rotation would not have hit.
   */
  private rotationDeps(installDir: string, secretsDir: string): RotationDeps {
    return {
      exec: (service, argv, extraEnv) => {
        // `env` here sets the environment of the HOST docker client, which the
        // container never sees: `docker compose exec` does not forward the
        // caller's environment. PGPASSWORD set that way left psql prompting for
        // a password on stdin, so every PostgreSQL verification failed - and,
        // because rollback verifies the same way, rollback "failed" too and the
        // operator was told the rotation was unrecoverable while the stack was
        // in fact fine. The value has to travel as `-e KEY=VALUE` on the exec.
        const envFlags = Object.entries(extraEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
        return execFileSync(
          "docker",
          ["compose", "-f", COMPOSE_FILE, "exec", "-T", ...envFlags, service, ...argv],
          {
            cwd: installDir,
            encoding: "utf8",
            // Never inherit stdin. If a credential does not arrive, the tool
            // must fail rather than block forever on an interactive prompt.
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      },
      recreate: (services) => {
        // --force-recreate is load-bearing. A secret is a FILE mount, so
        // changing its contents changes nothing compose can see: plain `up -d`
        // compares the rendered config, finds it identical, and leaves the
        // container running with the credential it started with. MinIO then
        // never adopts, and command-adoption CLIENTS keep the value they read
        // at startup while the server-side check still passes.
        execFileSync(
          "docker",
          ["compose", "-f", COMPOSE_FILE, "up", "-d", "--force-recreate", ...services],
          { cwd: installDir, stdio: "pipe" },
        );
      },
      readSecret: (file) => fs.readFileSync(path.join(secretsDir, file), "utf8").trim(),
      writeSecret: (file, value) => {
        const target = path.join(secretsDir, file);
        if (fs.existsSync(target)) {
          fs.copyFileSync(target, target + ".bak");
          fs.chmodSync(target + ".bak", 0o600);
        }
        fs.writeFileSync(target, value, { mode: 0o600 });
      },
      log: (message) => info(message),
    };
  }

  private rotationConfig(env: Record<string, string>): RotationConfig {
    return {
      postgresUser: env["POSTGRES_USER"] ?? "syn",
      postgresDb: env["POSTGRES_DB"] ?? "syn",
      // Same default the compose file uses for MINIO_ROOT_USER. A mismatch here
      // fails verification for every value, old and new alike.
      minioUser: env["MINIO_ROOT_USER"] ?? "minioadmin",
    };
  }

  /**
   * Rotate the three generated service secrets, verifying each against its own
   * service before the new value is left in place (#56).
   *
   * Each server adopts a new credential differently, so this is not a loop over
   * three files. See src/rotation.ts for the measured mechanisms and the
   * ordering they imply.
   */
  private async credentialsRotate(installDir: string): Promise<void> {
    const secretsDir = path.join(installDir, "secrets");
    const envPath = path.join(installDir, ".env");

    if (!fs.existsSync(secretsDir)) {
      fail("No secrets directory found.");
      info(`Expected: ${secretsDir}`);
      return;
    }

    const env = new ConfigManager(installDir).readEnv();

    console.log();
    info(bold("Credential Rotation"));
    console.log();
    info("This generates new PostgreSQL, Redis and MinIO credentials, asks each");
    info("server to adopt its new value, and then authenticates to confirm it did.");
    info("Any credential that cannot be verified is rolled back automatically.");
    console.log();
    warn("Services restart during this. Do not run it while work is in flight.");
    console.log();

    const proceed = await confirm("Rotate service credentials?", false);
    if (!proceed) {
      info("Cancelled.");
      return;
    }

    // The .env backup keeps `credentials rollback` working as before.
    if (fs.existsSync(envPath)) {
      fs.copyFileSync(envPath, path.join(installDir, ".env.backup"));
      fs.chmodSync(path.join(installDir, ".env.backup"), 0o600);
    }

    const deps = this.rotationDeps(installDir, secretsDir);
    const cfg = this.rotationConfig(env);

    console.log();
    let results;
    try {
      results = rotateAll(deps, cfg);
    } catch (err) {
      // Only thrown when a rotation failed AND its rollback also failed, which
      // is the one case an operator must not be allowed to scroll past.
      console.log();
      fail("Rotation failed and could not be rolled back.");
      if (err instanceof Error) info(err.message);
      info(`Previous values are in ${secretsDir} alongside each .bak file.`);
      process.exitCode = 1;
      return;
    }

    console.log();
    const rotated = results.filter((r) => r.status === "rotated");
    const reverted = results.filter((r) => r.status !== "rotated");

    for (const r of rotated) success(`${r.label} rotated and verified`);
    for (const r of reverted) warn(`${r.label} rolled back: ${r.error ?? "unknown reason"}`);

    console.log();
    if (reverted.length === 0) {
      success(`All ${rotated.length} service credentials rotated.`);
    } else {
      warn(`${rotated.length} rotated, ${reverted.length} rolled back.`);
      info("Rolled-back credentials are unchanged and still working.");
      process.exitCode = 1;
    }
  }

  /**
   * Restore credentials from the last pre-rotation backup.
   *
   * The backup is written to .env.backup before any rotation step, so this
   * command returns the stack to its last known-good credential state.
   */
  private async credentialsRollback(installDir: string): Promise<void> {
    const secretsDir = path.join(installDir, "secrets");

    // Rotation changes two things: the value in secrets/<name>.secret, and the
    // credential the SERVER holds. It does not touch .env - none of these three
    // credentials live there.
    //
    // This command used to restore .env from .env.backup and restart the stack.
    // That restored nothing (`grep -c` for the service passwords in .env
    // returns 0), bounced every container, and then reported "Credentials
    // restored from backup". A destructive no-op that claimed success.
    //
    // A real rollback puts each server back on its previous credential and
    // leaves the file agreeing with it, which is exactly what rotation's own
    // rollback path does - reused here rather than reimplemented.
    const restorable = CREDENTIALS.filter((spec) =>
      fs.existsSync(path.join(secretsDir, spec.file + ".bak")),
    );

    if (restorable.length === 0) {
      fail("No credential backup found.");
      info(`Expected: ${path.join(secretsDir, "<name>.secret.bak")}`);
      info("A backup is written automatically before each rotation. If none exists,");
      info("credentials have not been rotated via this tool.");
      return;
    }

    const env = new ConfigManager(installDir).readEnv();

    console.log();
    info(bold("Credential Rollback"));
    console.log();
    info(`Restoring: ${restorable.map((s) => s.label).join(", ")}`);
    info("Each server is put back on its previous credential and then");
    info("authenticated with it, so a rollback that did not take is not");
    info("reported as one that did.");
    console.log();
    warn("Services restart during this. Do not run it while work is in flight.");
    console.log();

    const proceed = await confirm("Restore previous credentials?", false);
    if (!proceed) {
      info("Cancelled.");
      return;
    }

    const deps = this.rotationDeps(installDir, secretsDir);
    const cfg = this.rotationConfig(env);

    console.log();
    const failed: string[] = [];
    for (const spec of restorable) {
      const previous = fs.readFileSync(path.join(secretsDir, spec.file + ".bak"), "utf8").trim();
      try {
        rollbackOne(deps, cfg, spec, previous);
        success(`${spec.label} restored and verified`);
      } catch (err) {
        failed.push(spec.label);
        fail(`${spec.label} could NOT be restored: ${err instanceof Error ? err.message : err}`);
      }
    }

    console.log();
    if (failed.length === 0) {
      success(`All ${restorable.length} credentials restored from backup.`);
    } else {
      fail(`${failed.join(", ")} could not be restored. Investigate before running work.`);
      process.exitCode = 1;
    }
    console.log();
    this.credentialsShow(installDir);
  }

  /** Print gateway credential retrieval instructions (never prints the password). */
  private credentialsShow(installDir: string): void {
    const envPath = path.join(installDir, ".env");
    const quotedEnvPath = `"${envPath}"`;
    const config = new ConfigManager(installDir);
    const existingEnv = config.readEnv();
    const username = existingEnv[ENV_KEYS.SYN_API_USER] || DEFAULT_API_USER;
    console.log();
    info(bold("Gateway credentials"));
    console.log();
    info(`  Saved to: ${dim(envPath)}`);
    console.log();
    info(`  Username: ${cyan(username)}`);
    console.log();
    info(`  View password:`);
    info(`    ${dim(`grep ${ENV_KEYS.SYN_API_PASSWORD} ${quotedEnvPath} | cut -d= -f2`)}`);
    console.log();
    info(`  Copy to clipboard (macOS):`);
    info(`    ${dim(`grep ${ENV_KEYS.SYN_API_PASSWORD} ${quotedEnvPath} | cut -d= -f2 | pbcopy`)}`);
    console.log();
    info(`  ${bold("syn")} CLI access:`);
    info(`    ${dim(`export ${ENV_KEYS.SYN_API_USER}=${username}`)}`);
    info(`    ${dim(`export ${ENV_KEYS.SYN_API_PASSWORD}=$(grep ${ENV_KEYS.SYN_API_PASSWORD} ${quotedEnvPath} | cut -d= -f2)`)}`);
    console.log();
    info(`  Roll back a rotation: ${cyan(`${BIN} credentials rollback`)}`);
    console.log();
  }

  // ── Interactive menu ──────────────────────────────────────────────────

  private async showMenu(): Promise<CliOptions["command"]> {
    banner(PLATFORM_VERSION);
    // Flair target = subtitle line in banner. From the save point (after title+blank),
    // count up: blank(1) + title(1) + blank-after-banner(1) + bottom-border(1) + url(1) + subtitle(1) = 6
    const flairLinesAboveSave = 6;

    const installDir = path.resolve(this.opts.dir || DEFAULT_INSTALL_DIR);
    const initDone = new ConfigManager(installDir).exists();

    // Commands that require a completed init (install dir must exist)
    const requiresInit = new Set([
      "status", "stop", "start", "logs", "update",
      "credentials", "tunnel", "github-app",
    ]);

    const menuItems: MenuItem[] = COMMANDS.map((c) => {
      const needsInit = requiresInit.has(c.name);
      const disabled = needsInit && !initDone;
      return {
        label: c.name,
        value: c.name,
        description: c.description,
        disabled,
        disabledReason: disabled ? `run ${CMD.init} first` : undefined,
      };
    });

    const choice = await interactiveMenu(
      menuItems,
      "What would you like to do?",
      { linesAboveSave: flairLinesAboveSave, col: 5 },
    );
    console.log();
    return choice as CliOptions["command"];
  }

  // ── Arg parsing ───────────────────────────────────────────────────────

  static parseArgs(argv: string[]): CliOptions {
    const args = argv.slice(2);

    if (args.includes("--help") || args.includes("-h")) {
      CLI.printHelp();
      process.exit(0);
    }
    if (args.includes("--version") || args.includes("-v")) {
      console.log(VERSION);
      process.exit(0);
    }

    const subcommands = ["init", "status", "stop", "start", "logs", "update", "skills", "plugin", "github-app", "tunnel", "cli", "credentials", "reset", "help"] as const;
    type Subcommand = (typeof subcommands)[number];
    const firstArg = args[0];
    let command: CliOptions["command"] = "menu";

    if (firstArg && subcommands.includes(firstArg as Subcommand)) {
      if (firstArg === "help") {
        CLI.printHelp();
        process.exit(0);
      }
      command = firstArg as Subcommand;
    }

    const opts: CliOptions = { command };

    // Parse sub-action for `credentials` command
    if (command === "credentials" && args[1]) {
      const secondArg = args[1];
      if (secondArg === "show" || secondArg === "rotate" || secondArg === "rollback") {
        opts.credentialsAction = secondArg;
      }
    }

    // Parse sub-action for `skills` command: the positionals after the
    // command, wherever the flags sit (`skills --yes status` is `status`).
    if (command === "skills") {
      const positionals = CLI.positionals(args.slice(1));
      const action = positionals[0];
      const isAction = (a: string): a is SkillsAction => a === "install" || a === "update" || a === "status";
      if (positionals.length > 1 || (action !== undefined && !isAction(action))) {
        fail(`Unknown skills action: ${positionals.join(" ")}`);
        info(`Usage: ${CMD.skills} [install|update|status]`);
        process.exit(1);
      }
      if (action !== undefined && isAction(action)) opts.skillsAction = action;
    }

    // `--flag=value` is the same as `--flag value`.
    const flags = args.flatMap((a) => {
      const eq = a.indexOf("=");
      return a.startsWith("--") && eq > 0 && CLI.VALUE_FLAGS.has(a.slice(0, eq)) ? [a.slice(0, eq), a.slice(eq + 1)] : [a];
    });
    const valueOf = (i: number, flag: string): string => {
      const v = flags[i];
      if (v === undefined || v === "" || v.startsWith("-")) {
        fail(`${flag} needs a value.`);
        process.exit(1);
      }
      return v;
    };
    // reset is destructive: an argument it does not understand is an error,
    // never something to ignore.
    const RESET_FLAGS = new Set(["--dir", "--yes", "-y", "--no-backup", "--images", "--cli", "--skills", "--all"]);

    for (let i = 0; i < flags.length; i++) {
      const arg = flags[i]!;
      if (command === "reset" && i > 0 && !RESET_FLAGS.has(arg)) {
        fail(`Unknown reset argument: ${arg}`);
        info(`Usage: ${CMD.reset} [--yes] [--no-backup] [--images] [--cli] [--skills] [--all] [--dir <path>]`);
        process.exit(1);
      }
      switch (arg) {
        case "--org":
          opts.org = valueOf(++i, arg);
          break;
        case "--name":
          opts.name = valueOf(++i, arg);
          break;
        case "--dir":
          opts.dir = valueOf(++i, arg);
          break;
        case "--skip-github":
          opts.skipGithub = true;
          break;
        case "--skip-docker":
          opts.skipDocker = true;
          break;
        case "--webhook-url":
          opts.webhookUrl = valueOf(++i, arg);
          break;
        case "--yes":
        case "-y":
          opts.yes = true;
          break;
        case "--no-backup":
          opts.noBackup = true;
          break;
        case "--images":
          opts.images = true;
          break;
        case "--cli":
          opts.cli = true;
          break;
        case "--skills":
          opts.skills = true;
          break;
        case "--all":
          opts.images = true;
          opts.cli = true;
          opts.skills = true;
          break;
      }
    }

    return opts;
  }

  /** Flags that consume the next argument as their value. */
  private static readonly VALUE_FLAGS = new Set(["--org", "--name", "--dir", "--webhook-url"]);

  /** Non-flag arguments, skipping flags and the values they consume. */
  static positionals(args: readonly string[]): string[] {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (CLI.VALUE_FLAGS.has(a)) { i++; continue; }
      if (a.startsWith("-")) continue;
      out.push(a);
    }
    return out;
  }

  private static printHelp(): void {
    // Build usage lines dynamically from COMMANDS
    const usage = COMMANDS.map((c) => ({
      cmd: `${BIN} ${c.name}${c.args ? " " + c.args : ""}`,
      description: c.description,
    }));
    const col = Math.max(34, ...usage.map((u) => u.cmd.length + 2));
    const usageLines = usage.map((u) => `    ${u.cmd.padEnd(col)}${u.description}`).join("\n");

    console.log(`
  ${bold("syntropic137")} v${VERSION} — self-host setup CLI

  ${bold("USAGE")}
    ${BIN.padEnd(col)}Interactive menu
${usageLines}

  ${bold("OPTIONS")}
    --org <name>          GitHub org for the app (default: personal)
    --name <app-name>     GitHub App name (default: ${DEFAULT_APP_NAME})
    --dir <path>          Install directory (default: ~/.syntropic137)
    --skip-github         Skip GitHub App creation
    --skip-docker         Skip Docker pull/up (templates only)
    --webhook-url <url>   Webhook URL for the GitHub App
    -y, --yes             Answer yes instead of asking (installing the agent skills
                          in a non-interactive init, removing the legacy plugin)
    -h, --help            Show this help
    -v, --version         Show version

  ${bold("RESET OPTIONS")} ${dim("(reset is a dry run until you add --yes)")}
    --yes                 Actually remove what the dry run lists
    --no-backup           Delete the install dir instead of moving it to a backup
    --images              Also remove ghcr.io/syntropic137/* images
    --cli                 Also uninstall the syn CLI (npm uninstall -g)
    --skills              Also remove the Syntropic137 agent skills
    --all                 --images --cli --skills
`);
  }

  private resolveDir(dir: string): string {
    if (!fs.existsSync(dir)) {
      fail(`Install directory not found: ${dir}`);
      info(`Run \`${CMD.init}\` first.`);
      process.exit(1);
    }
    return dir;
  }
}

// ---------------------------------------------------------------------------
// Anthropic credential routing
// ---------------------------------------------------------------------------

/**
 * Route a pasted Anthropic credential to the correct env var by prefix.
 *
 * Claude Code CLI requires the credential under a specific env var matching
 * its type. Pasting an OAuth token into ANTHROPIC_API_KEY (or vice versa)
 * silently breaks every workflow run because the platform reads each var
 * independently and the CLI rejects mismatched types at its local format
 * check.
 *
 * Returns null if the token does not look like a recognised Anthropic
 * credential. The caller is responsible for messaging that to the user.
 *
 * Notes on the prefix table (current as of 2026-05):
 *   sk-ant-oat01-…  Claude Code OAuth token from `claude setup-token`
 *   sk-ant-…        Anthropic API key from console.anthropic.com (anything
 *                   else with the sk-ant- prefix that isn't oat01)
 */
export function routeAnthropicCredential(
  raw: string,
): { envKey: string; value: string } | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("sk-ant-oat01-")) {
    return { envKey: ENV_KEYS.CLAUDE_CODE_OAUTH_TOKEN, value };
  }
  if (value.startsWith("sk-ant-")) {
    return { envKey: ENV_KEYS.ANTHROPIC_API_KEY, value };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Backward-compatible exports (used by tests)
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliOptions {
  return CLI.parseArgs(argv);
}

export async function runInit(opts: CliOptions): Promise<void> {
  return new InitFlow(opts).run();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await new CLI(process.argv).run();
}

// Guard: skip auto-run when loaded as a module (e.g. vitest).
// When run via npx, argv[1] is the bin symlink (e.g. .bin/syntropic137),
// not cli.js — so we check for both.
const entryArg = process.argv[1] ?? "";
const isDirectRun =
  entryArg.endsWith("cli.js") || entryArg.endsWith("syntropic137");
if (isDirectRun) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
