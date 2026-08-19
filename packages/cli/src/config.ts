import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** §4.7 login：token 存 ~/.agenthub/config.json；AGENTHUB_HUB_URL 可覆盖（§5.2） */

export interface CliConfig {
  hubUrl: string;
  token?: string;
}

const DEFAULT_HUB_URL = 'http://localhost:3000';

export function configPath(): string {
  return join(process.env.AGENTHUB_CONFIG_DIR ?? join(homedir(), '.agenthub'), 'config.json');
}

export function loadConfig(): CliConfig {
  const p = configPath();
  let cfg: CliConfig = { hubUrl: DEFAULT_HUB_URL };
  if (existsSync(p)) {
    cfg = { ...cfg, ...(JSON.parse(readFileSync(p, 'utf8')) as CliConfig) };
  }
  if (process.env.AGENTHUB_HUB_URL) cfg.hubUrl = process.env.AGENTHUB_HUB_URL;
  return cfg;
}

export function saveConfig(cfg: CliConfig): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cfg, null, 2));
}
