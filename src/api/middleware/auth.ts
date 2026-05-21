import APIException from '@/lib/exceptions/APIException.ts';
import EX from '@/api/consts/exceptions.ts';
import { validateAdminKey, validateApiKey, getRefreshTokens } from '@/lib/auth/keys.ts';

export const ANONYMOUS_TOKEN = '__stepfun_anonymous__';

const tokenRoundRobinIndex = new Map<string, number>();

export function isAnonymousModeEnabled(): boolean {
  return process.env.STEPFUN_ANONYMOUS_MODE === '1' || process.env.STEPFUN_FREE_MODE === '1';
}

export function isAnonymousToken(token: string): boolean {
  return token === ANONYMOUS_TOKEN;
}

/**
 * 从 Authorization header 解析 refresh tokens
 *
 * 支持两种方式:
 * 1. API Key 方式: Authorization: Bearer sk-xxx → 从配置映射 accounts 并转为 deviceId@oasisToken
 * 2. 直接 StepFun refresh_token 方式 (向后兼容): Authorization: Bearer tok1,tok2,tok3
 *
 * @param authorization Authorization header 值
 * @returns refresh token 数组 (格式: deviceId@oasisToken)
 */
export function resolveTokens(authorization = ""): string[] {
  const raw = authorization.replace(/^Bearer\s+/i, "").trim();

  if (!raw && isAnonymousModeEnabled()) {
    return [ANONYMOUS_TOKEN];
  }

  // 先尝试 API Key 查找
  const apiKeyEntry = validateApiKey(raw);
  if (apiKeyEntry) {
    return getRefreshTokens(apiKeyEntry);
  }

  // 向后兼容: 直接作为 StepFun refresh_token 使用 (逗号分隔多个)
  return raw.split(",").map(t => t.trim()).filter(Boolean);
}

export function selectToken(authorization = ""): string {
  const tokens = resolveTokens(authorization);
  if (tokens.length === 0) throw new Error('No available refresh token');
  const raw = authorization.replace(/^Bearer\s+/i, "").trim();
  const key = raw || tokens.join(",");
  const index = tokenRoundRobinIndex.get(key) || 0;
  tokenRoundRobinIndex.set(key, (index + 1) % tokens.length);
  return tokens[index % tokens.length];
}

/**
 * 验证 admin 身份
 *
 * @param authorization Authorization header 值
 */
export function requireAdmin(authorization: string): void {
  const token = authorization?.replace("Bearer ", "").trim();
  if (!validateAdminKey(token)) {
    throw new APIException(EX.API_REQUEST_PARAMS_INVALID, 'Admin authentication failed');
  }
}
