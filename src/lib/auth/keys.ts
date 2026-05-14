import path from 'path';
import fs from 'fs-extra';
import _ from 'lodash';
import logger from '@/lib/logger.ts';

export interface AccountEntry {
  device_id: string;
  oasis_token: string;
}

export interface ApiKeyEntry {
  name: string;
  /** 账号列表，每个包含 device_id 和 oasis_token */
  accounts: AccountEntry[];
  remark?: string;
}

export interface ApiConfig {
  admin_key: string;
  api_keys: Record<string, ApiKeyEntry>;
}

const CONFIG_PATH = path.resolve('config/api.json');

let config: ApiConfig | null = null;

function loadConfig(): ApiConfig {
  try {
    if (!fs.pathExistsSync(CONFIG_PATH)) {
      logger.warn(`API config not found at ${CONFIG_PATH}, using defaults`);
      return { admin_key: 'admin', api_keys: {} };
    }
    const data = fs.readJsonSync(CONFIG_PATH) as ApiConfig;
    logger.success(`API config loaded: ${Object.keys(data.api_keys || {}).length} keys`);
    return {
      admin_key: data.admin_key || 'admin',
      api_keys: data.api_keys || {},
    };
  } catch (err) {
    logger.error(`Failed to load API config: ${err}`);
    return { admin_key: 'admin', api_keys: {} };
  }
}

export function getConfig(): ApiConfig {
  if (!config) config = loadConfig();
  return config;
}

export function reloadConfig(): ApiConfig {
  config = loadConfig();
  return config;
}

export function validateApiKey(key: string): ApiKeyEntry | null {
  const cfg = getConfig();
  const entry = cfg.api_keys[key];
  if (!entry || !entry.accounts || entry.accounts.length === 0) return null;
  return entry;
}

/**
 * 将 ApiKeyEntry 的 accounts 转换为 deviceId@oasisToken 格式的字符串数组
 */
export function getRefreshTokens(entry: ApiKeyEntry): string[] {
  return entry.accounts.map(a => `${a.device_id}@${a.oasis_token}`);
}

export function validateAdminKey(key: string): boolean {
  const cfg = getConfig();
  return key === cfg.admin_key;
}

export function addApiKey(key: string, entry: ApiKeyEntry): void {
  const cfg = getConfig();
  cfg.api_keys[key] = entry;
  saveConfig(cfg);
}

export function removeApiKey(key: string): boolean {
  const cfg = getConfig();
  if (!cfg.api_keys[key]) return false;
  delete cfg.api_keys[key];
  saveConfig(cfg);
  return true;
}

export function listApiKeys(): Record<string, ApiKeyEntry> {
  return getConfig().api_keys;
}

export function setAdminKey(key: string): void {
  const cfg = getConfig();
  cfg.admin_key = key;
  saveConfig(cfg);
}

function saveConfig(cfg: ApiConfig): void {
  try {
    fs.ensureDirSync(path.dirname(CONFIG_PATH));
    fs.writeJsonSync(CONFIG_PATH, cfg, { spaces: 2 });
  } catch (err) {
    logger.error(`Failed to save API config: ${err}`);
  }
}
