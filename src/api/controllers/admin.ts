import _ from 'lodash';

import logger from '@/lib/logger.ts';
import { addApiKey, removeApiKey, listApiKeys, setAdminKey, getConfig, reloadConfig, validateApiKey, validateAdminKey } from '@/lib/auth/keys.ts';

/**
 * 获取系统状态
 */
function getStatus() {
  const cfg = getConfig();
  return {
    admin_configured: !!cfg.admin_key,
    api_key_count: Object.keys(cfg.api_keys || {}).length,
  };
}

/**
 * 获取所有 API keys (隐藏完整 refresh_tokens)
 */
function getApiKeys() {
  const keys = listApiKeys();
  return Object.entries(keys).map(([key, entry]) => ({
    key,
    name: entry.name,
    remark: entry.remark || '',
    account_count: (entry.accounts || []).length,
  }));
}

/**
 * 创建 API key
 */
function createApiKey(key: string, name: string, accounts: { device_id: string; oasis_token: string }[], remark?: string) {
  if (!key || !name || !accounts || accounts.length === 0) {
    throw new Error('key, name, and accounts are required');
  }

  const existing = validateApiKey(key);
  if (existing) {
    throw new Error(`API key "${key}" already exists`);
  }

  addApiKey(key, {
    name,
    accounts,
    remark: remark || '',
  });

  logger.success(`API key created: ${key} (${name})`);
  return { key, name, account_count: accounts.length };
}

/**
 * 删除 API key
 */
function deleteApiKey(key: string) {
  const removed = removeApiKey(key);
  if (!removed) {
    throw new Error(`API key "${key}" not found`);
  }
  logger.success(`API key deleted: ${key}`);
  return { key, deleted: true };
}

/**
 * 更新 admin key
 */
function updateAdminKey(newKey: string) {
  if (!newKey || newKey.length < 4) {
    throw new Error('Admin key must be at least 4 characters');
  }
  setAdminKey(newKey);
  logger.success(`Admin key updated`);
  return { updated: true };
}

/**
 * 重新加载配置
 */
function reloadApiConfig() {
  reloadConfig();
  logger.success(`API config reloaded`);
  return getStatus();
}

export default { getStatus, getApiKeys, createApiKey, deleteApiKey, updateAdminKey, reloadApiConfig };
