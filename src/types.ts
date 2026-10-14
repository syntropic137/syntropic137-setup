/** Sub-actions of the `skills` command. */
export type SkillsAction = "install" | "update" | "status";

/** CLI options parsed from argv. */
export interface CliOptions {
  command: "init" | "status" | "stop" | "start" | "logs" | "update" | "skills" | "plugin" | "github-app" | "tunnel" | "cli" | "credentials" | "reset" | "menu" | "help";
  /** Sub-action for the `credentials` command. */
  credentialsAction?: "show" | "rotate" | "rollback";
  /** Sub-action for the `skills` command (default: install). */
  skillsAction?: SkillsAction;
  /** `--yes`: explicit consent for prompts that otherwise default to no. */
  yes?: boolean;
  /** reset: delete the install dir instead of backing it up (`--no-backup`). */
  noBackup?: boolean;
  /** reset: also remove ghcr.io/syntropic137/* images. */
  images?: boolean;
  /** reset: also uninstall the syn CLI. */
  cli?: boolean;
  /** reset: also remove the agent skills. */
  skills?: boolean;
  org?: string;
  name?: string;
  dir?: string;
  skipGithub?: boolean;
  skipDocker?: boolean;
  /** init: `--install-cli` (true) installs the syn CLI without asking, `--no-install-cli` (false) skips it. */
  installCli?: boolean;
  webhookUrl?: string;
}

/** Values collected during the init flow and written to .env. */
export interface EnvValues {
  APP_ENVIRONMENT: string;
  SYN_VERSION: string;
  SYN_INSTALL_DIR?: string;
  SYN_API_USER?: string;
  SYN_API_PASSWORD?: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  SYN_GITHUB_APP_ID?: string;
  SYN_GITHUB_APP_NAME?: string;
  SYN_GITHUB_APP_ORG?: string;
  SYN_GITHUB_WEBHOOK_SECRET?: string;
  SYN_GATEWAY_PORT?: string;
  MINIO_ROOT_USER?: string;
  [key: string]: string | undefined;
}

/** Result from the GitHub App Manifest flow. */
export interface ManifestResult {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
  html_url: string;
}

/** GitHub App Manifest permissions. */
export interface AppPermissions {
  [key: string]: "read" | "write";
}
