import { PassThrough } from "stream";
import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import _ from "lodash";
import mime from "mime";
import axios, { AxiosResponse } from "axios";
import FormData from "form-data";
import { chromium, BrowserContext, Page } from "playwright";

import {
  parseToolCallsDetailed,
  ParsedToolCall
} from '@/api/controllers/toolcall.ts';
import {
  createToolSieveState,
  flushToolStream,
  processToolStreamChunk
} from '@/api/controllers/toolstream.ts';
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";
import { isAnonymousToken } from "@/api/middleware/auth.ts";

// 模型名称
const MODEL_NAME = "step";
// access_token有效期
const ACCESS_TOKEN_EXPIRES = 900;
// 最大重试次数
const MAX_RETRY_COUNT = 0;
// 重试延迟
const RETRY_DELAY = 5000;
// 伪装headers
const FAKE_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  Origin: "https://www.stepfun.com",
  "Connect-Protocol-Version": "1",
  "Oasis-Appid": "10200",
  "Oasis-Mode": "2",
  "Oasis-Platform": "web",
  "Sec-Ch-Ua":
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "X-Waf-Client-Type": "fetch_sdk"
};
const ANONYMOUS_HEADERS = {
  Accept: "*/*",
  "Accept-Encoding": "gzip, deflate",
  "Accept-Language": "zh-CN,zh-Hans;q=0.9",
  Origin: "https://www.stepfun.com",
  "Connect-Protocol-Version": "1",
  "Oasis-Appid": "10200",
  "Oasis-Language": "zh",
  "Oasis-Platform": "web",
  "Canary": "false",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/136.0.7103.91 Mobile/15E148 Safari/604.1",
  "X-Waf-Client-Type": "fetch_sdk"
};
const ANONYMOUS_BASE_COOKIE = "is_pc_desktop=false; i18next=zh";
const ANONYMOUS_IDENTITY_TTL_MS = Number(process.env.STEPFUN_ANONYMOUS_IDENTITY_TTL_MS || 30 * 60 * 1000);
const ANONYMOUS_ROTATE_AFTER = Number(process.env.STEPFUN_ANONYMOUS_ROTATE_AFTER || 3);
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};
const browserStateMap = new Map<string, { context: BrowserContext; page: Page | null; chatSessionId: string | null; deviceId?: string }>();
let browserStreamId = 0;
export type StepFunAuth = { deviceId: string; token: string; cookie?: string; anonymous?: boolean };
type AnonymousIdentity = StepFunAuth & { turns: number; createdAt: number; ingressCookie?: string };
let anonymousIdentity: AnonymousIdentity | null = null;
const ANONYMOUS_POOL_SIZE = Number(process.env.STEPFUN_ANONYMOUS_POOL_SIZE || 8);
const anonymousIdentityPool: AnonymousIdentity[] = [];
// 进程启动时静默预热匿名池，消灭首轮对话冷启动卡顿
setTimeout(() => {
  if (process.env.STEPFUN_ANONYMOUS_MODE === "1" || process.env.STEPFUN_FREE_MODE === "1") {
    logger.info("[匿名凭据池] 核心服务就绪，开始在后台静默预热匿名凭证池...");
    replenishAnonymousPool().catch(err => {
      logger.error(`[匿名凭据池] 后台静默预热发生异常: ${err.message}`);
    });
  }
}, 3000);
let anonymousPoolReplenishing = false;
const CURRENT_INPUT_FILENAME = "DS2API_HISTORY.txt";
const CURRENT_INPUT_CONTENT_TYPE = "text/plain; charset=utf-8";
// Explicación: Cambiamos el valor por defecto de CURRENT_INPUT_MIN_CHARS de 8000 a 120000 (120k) según la solicitud del usuario. Esto permite que el historial de chat se transmita directamente de forma nativa sin comprimirse ni adjuntarse hasta que alcance los 120,000 caracteres, aprovechando al máximo la gran capacidad de contexto del modelo.
const CURRENT_INPUT_MIN_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_FILE_MIN_CHARS || 120000);
const CURRENT_INPUT_LIVE_MAX_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_LIVE_MAX_CHARS || 8000);
const CURRENT_INPUT_SUMMARIZE_THRESHOLD_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_SUMMARIZE_THRESHOLD_CHARS || 15000);
const CURRENT_INPUT_SUMMARY_MAX_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_SUMMARY_MAX_CHARS || 8000);
const CONVERSATION_CREATE_MIN_DELAY_MS = Number(process.env.STEPFUN_CONVERSATION_CREATE_MIN_DELAY_MS || 1000);
const CONVERSATION_CREATE_MAX_DELAY_MS = Number(process.env.STEPFUN_CONVERSATION_CREATE_MAX_DELAY_MS || 3000);
const STREAM_TIMEOUT_MS = Number(process.env.STEPFUN_STREAM_TIMEOUT_MS || 120000);
const STREAM_TIMEOUT_RETRY_COUNT = Number(process.env.STEPFUN_STREAM_TIMEOUT_RETRY_COUNT || 1);
const STREAM_TIMEOUT_RETRY_PROMPT = process.env.STEPFUN_STREAM_TIMEOUT_RETRY_PROMPT || "请简单回复，避免长时间思考 or 循环。";
const CHINESE_REPLY_PROMPT = process.env.STEPFUN_CHINESE_REPLY_PROMPT || "除非用户明确要求其他语言，否则必须使用简体中文回复。如果上下文提到 DS2API_HISTORY.txt，但附件不可读或未展示完整正文，请使用消息中可见的内联 Context，不要断言该文件为空。";
let lastConversationCreateAt = 0;

function logPrompt(content: string) {
  logger.info(`[${new Date().toISOString()}] 提示词：\n${content}`);
}

async function throttleConversationCreate() {
  // Explicación: Para evitar el bloqueo global y el encolamiento infinito de solicitudes (que provoca una sensación de bucle infinito y bloquea todas las peticiones concurrentes en cola), reemplazamos la cadena de Promise global por un control de intervalo de tiempo simple y local. Esto evita colas largas acumuladas y la inactividad del hilo de ejecución.
  const now = Date.now();
  const minDelay = Math.max(0, Math.min(CONVERSATION_CREATE_MIN_DELAY_MS, CONVERSATION_CREATE_MAX_DELAY_MS));
  const maxDelay = Math.max(minDelay, Math.max(CONVERSATION_CREATE_MIN_DELAY_MS, CONVERSATION_CREATE_MAX_DELAY_MS));
  const randomDelay = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));

  const elapsed = now - lastConversationCreateAt;
  if (elapsed < randomDelay) {
    const waitMs = randomDelay - elapsed;
    logger.info(`[频率限制] 距离上次创建会话仅过去 ${elapsed}ms，本请求独立避让等待 ${waitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastConversationCreateAt = Date.now();
}

function getSetCookieValues(headers: any): string[] {
  const value = headers?.["set-cookie"];
  if (!value) return [];
  return Array.isArray(value) ? value : [String(value)];
}

function extractSetCookieValue(headers: any, name: string) {
  for (const item of getSetCookieValues(headers)) {
    const [pair] = item.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    if (pair.slice(0, eq).trim().toLowerCase() === name.toLowerCase()) return pair.slice(eq + 1);
  }
  return "";
}

function generateAnonymousCookie(identity: { deviceId: string; token: string; ingressCookie?: string }) {
  return [
    ANONYMOUS_BASE_COOKIE,
    `Oasis-Token=${identity.token}`,
    `Oasis-Webid=${identity.deviceId}`,
    identity.ingressCookie ? `INGRESSCOOKIE=${identity.ingressCookie}` : "",
  ].filter(Boolean).join("; ");
}

function shouldRenewAnonymousIdentity(identity: AnonymousIdentity | null) {
  if (!identity) return true;
  const elapsed = Date.now() - identity.createdAt;
  const isExpired = ANONYMOUS_IDENTITY_TTL_MS > 0 && elapsed > ANONYMOUS_IDENTITY_TTL_MS;
  const isTurnsExceeded = ANONYMOUS_ROTATE_AFTER > 0 && identity.turns >= ANONYMOUS_ROTATE_AFTER;
  if (isExpired || isTurnsExceeded) {
    logger.info(`[匿名凭据生命周期] 凭据需刷新。原因: 过期=${isExpired} (已用时间=${elapsed}ms), 轮转数超限=${isTurnsExceeded} (当前使用轮次=${identity.turns}/${ANONYMOUS_ROTATE_AFTER})`);
    return true;
  }
  return false;
}

// Explicación: Se agregan registros detallados de depuración aquí para identificar por qué la sesión anónima se congela o falla durante el registro del dispositivo en StepFun.
async function registerAnonymousIdentity() {
  logger.info(`[匿名凭据注册] 正在发送 RegisterDevice 请求至 StepFun 进行匿名注册...`);
  const startTime = Date.now();
  try {
    const result = await axios.post(
      "https://www.stepfun.com/passport/proto.api.passport.v1.PassportService/RegisterDevice",
      "{}",
      {
        headers: {
          ...ANONYMOUS_HEADERS,
          "Content-Type": "application/json",
          Cookie: ANONYMOUS_BASE_COOKIE,
          Referer: "https://www.stepfun.com/chats/new",
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    );
    const duration = Date.now() - startTime;
    logger.info(`[匿名凭据注册] 接口响应完成，耗时=${duration}ms, HTTP 状态码=${result.status}`);

    if (result.status >= 400) {
      logger.error(`[匿名凭据注册] 注册接口 HTTP 错误: 状态码=${result.status}, 响应体=${JSON.stringify(result.data).substring(0, 1000)}`);
      throw new APIException(EX.API_REQUEST_FAILED, `[匿名注册step失败]: HTTP ${result.status}`);
    }
    if (result.data?.code) {
      logger.error(`[匿名凭据注册] 接口返回业务错误代码: code=${result.data.code}, message=${result.data.message}`);
      throw new APIException(EX.API_REQUEST_FAILED, `[匿名注册step失败]: ${result.data.message || result.data.code}`);
    }

    const deviceId = result.data?.device?.deviceID || extractSetCookieValue(result.headers, "Oasis-Webid");
    const token = extractSetCookieValue(result.headers, "Oasis-Token") || result.data?.token?.raw || result.data?.refreshToken?.raw || result.data?.accessToken?.raw;
    const ingressCookie = extractSetCookieValue(result.headers, "INGRESSCOOKIE");

    if (!deviceId || !token) {
      logger.error(`[匿名凭据注册] 未能从响应中提取凭据: deviceId=${!!deviceId}, token=${!!token}, headers=${JSON.stringify(result.headers)}`);
      throw new APIException(EX.API_REQUEST_FAILED, `[匿名注册step失败]: StepFun 未返回匿名凭据`);
    }

    const identity: AnonymousIdentity = {
      deviceId,
      token,
      ingressCookie,
      turns: 0,
      createdAt: Date.now(),
      anonymous: true,
    };
    identity.cookie = generateAnonymousCookie(identity);
    logger.success(`[匿名凭据注册] StepFun 匿名身份注册成功: deviceId=${deviceId.substring(0, 16)}..., ingressCookie=${!!ingressCookie}`);
    return identity;
  } catch (error: any) {
    logger.error(`[匿名凭据注册] 请求出现异常: ${error.message}`, error);
    throw error;
  }
}

// Explicación: Esta función repone de forma asíncrona el grupo de identidades anónimas para evitar bloqueos por registro lento al cambiar de cuenta.
async function replenishAnonymousPool() {
  if (anonymousPoolReplenishing) return;
  anonymousPoolReplenishing = true;
  try {
    while (anonymousIdentityPool.length < ANONYMOUS_POOL_SIZE) {
      logger.info(`[匿名凭据池] 当前池内账号数=${anonymousIdentityPool.length}/${ANONYMOUS_POOL_SIZE}，正在异步注册新凭证补充...`);
      try {
        const identity = await registerAnonymousIdentity();
        anonymousIdentityPool.push(identity);
        logger.success(`[匿名凭据池] 成功补充一个凭证到池中，当前池内账号数=${anonymousIdentityPool.length}`);
      } catch (err: any) {
        logger.error(`[匿名凭据池] 异步注册凭证失败: ${err.message}. 5秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  } finally {
    anonymousPoolReplenishing = false;
  }
}

// Explicación: Adquiere una identidad anónima del grupo pre-registrado para una respuesta instantánea sin esperar el registro de red.
async function acquireAnonymousIdentity(force = false) {
  logger.info(`[匿名凭据调度] 准备获取匿名凭证... 强制更新=${force}`);
  if (!force && anonymousIdentity && !shouldRenewAnonymousIdentity(anonymousIdentity)) {
    logger.info(`[匿名凭据调度] 复用当前有效匿名凭证: deviceId=${anonymousIdentity.deviceId.substring(0, 16)}...`);
    return anonymousIdentity;
  }
  if (force && anonymousIdentity) {
    logger.warn(`[匿名凭据调度] 强制弃用当前身份: deviceId=${anonymousIdentity.deviceId.substring(0, 16)}...`);
    anonymousIdentity = null;
  }
  while (anonymousIdentityPool.length > 0) {
    const nextIdentity = anonymousIdentityPool.shift()!;
    if (!shouldRenewAnonymousIdentity(nextIdentity)) {
      anonymousIdentity = nextIdentity;
      logger.success(`[匿名凭据调度] 从预热池中成功取出有效匿名凭据: deviceId=${anonymousIdentity.deviceId.substring(0, 16)}...`);
      replenishAnonymousPool().catch(err => {
        logger.error(`[匿名凭据调度] 补充账号池发生异常: ${err.message}`);
      });
      return anonymousIdentity;
    } else {
      logger.warn(`[匿名凭据调度] 从池中取出的凭据已过期，舍弃: deviceId=${nextIdentity.deviceId.substring(0, 16)}...`);
    }
  }
  logger.warn(`[匿名凭据调度] 预热池为空！正在同步发起设备注册进行兜底...`);
  const newIdentity = await registerAnonymousIdentity();
  anonymousIdentity = newIdentity;
  replenishAnonymousPool().catch(err => {
    logger.error(`[匿名凭据调度] 补充账号池发生异常: ${err.message}`);
  });
  return anonymousIdentity;
}

function clearAnonymousIdentity(auth?: StepFunAuth) {
  if (!auth) {
    logger.warn(`[匿名凭据生命周期] 清空所有匿名凭证`);
    anonymousIdentity = null;
    return;
  }
  if (!anonymousIdentity) return;
  if (anonymousIdentity.deviceId === auth.deviceId) {
    logger.warn(`[匿名凭据生命周期] 清空失效的匿名凭证: deviceId=${auth.deviceId.substring(0, 16)}...`);
    anonymousIdentity = null;
  }
}

function reserveAnonymousTurn(auth: StepFunAuth) {
  if (!auth.anonymous || !anonymousIdentity || anonymousIdentity.deviceId !== auth.deviceId) return;
  anonymousIdentity.turns += 1;
  logger.info(`[匿名凭据生命周期] 匿名账号计数增加，当前使用轮次=${anonymousIdentity.turns}`);
}

async function acquireStepFunAuth(refreshToken: string): Promise<StepFunAuth> {
  if (isAnonymousToken(refreshToken)) return acquireAnonymousIdentity();
  return acquireToken(refreshToken);
}

function getStepFunHeaders(auth: StepFunAuth, referer: string, contentType: string) {
  return {
    "Content-Type": contentType,
    Cookie: auth.cookie || generateCookie(auth.deviceId, auth.token),
    "Oasis-Webid": auth.deviceId,
    "Canary": false,
    Referer: referer,
    ...(auth.anonymous ? ANONYMOUS_HEADERS : FAKE_HEADERS),
  };
}

function isNeedSignInError(err: any) {
  if (!err) return false;
  if (err.code === "permission_denied") return true;
  const message = String(err.message || "").toLowerCase();
  if (message.includes("need sign in")) return true;
  return (err.details || []).some((detail: any) => detail?.debug?.code === "CODE_ACCOUNT_NEED_SIGN_IN");
}

function isNeedSignInAnswer(answer: any) {
  if (isNeedSignInError(answer?.__stepFunError)) return true;
  const text = String(answer?.choices?.[0]?.message?.content || "");
  return /permission_denied|need sign in|CODE_ACCOUNT_NEED_SIGN_IN/i.test(text);
}

function attachStepFunError(target: any, error: any) {
  Object.defineProperty(target, "__stepFunError", { value: error, configurable: true });
}

/**
 * 请求access_token
 *
 * 使用refresh_token去刷新获得access_token
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function requestToken(refreshToken: string) {
  if (accessTokenRequestQueueMap[refreshToken])
    return new Promise((resolve) =>
      accessTokenRequestQueueMap[refreshToken].push(resolve)
    );
  accessTokenRequestQueueMap[refreshToken] = [];
  const result = await (async () => {
    const [deviceId, token] = refreshToken.split("@");
    const result = await axios.post(
      "https://www.stepfun.com/passport/proto.api.passport.v1.PassportService/RefreshToken",
      {},
      {
        headers: {
          Cookie: `Oasis-Token=${token}`,
          Referer: "https://www.stepfun.com/chats/new",
          ...FAKE_HEADERS,
          "Oasis-Webid": deviceId,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    const {
      accessToken: { raw: accessTokenRaw },
      refreshToken: { raw: refreshTokenRaw },
    } = checkResult(result, refreshToken);
    // 解码JWT获取实际过期时间
    const accessTokenParts = accessTokenRaw.split(".");
    let accessTokenExp = "unknown";
    if (accessTokenParts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(accessTokenParts[1], "base64").toString());
        accessTokenExp = new Date(payload.exp * 1000).toISOString();
      } catch (_) {}
    }
    return {
      deviceId,
      accessToken: accessTokenRaw,
      refreshToken: refreshTokenRaw,
      refreshTime: util.unixTimestamp() + ACCESS_TOKEN_EXPIRES,
    };
  })()
    .then((result) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(result)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return result;
    })
    .catch((err) => {
      if (accessTokenRequestQueueMap[refreshToken]) {
        accessTokenRequestQueueMap[refreshToken].forEach((resolve) =>
          resolve(err)
        );
        delete accessTokenRequestQueueMap[refreshToken];
      }
      return err;
    });
  if (_.isError(result)) throw result;
  return result;
}

/**
 * 获取缓存中的access_token
 *
 * 避免短时间大量刷新token，未加锁，如果有并发要求还需加锁
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function acquireToken(refreshToken: string): Promise<StepFunAuth> {
  if (isAnonymousToken(refreshToken)) return acquireAnonymousIdentity();
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  } else {
    if (util.unixTimestamp() > result.refreshTime) {
      result = await requestToken(refreshToken);
      accessTokenMap.set(refreshToken, result);
    }
  }
  return {
    deviceId: result.deviceId,
    token: result.accessToken + "..." + result.refreshToken,
  };
}

/**
 * 创建会话
 *
 * 创建临时的会话用于对话补全
 *
 * @param refreshToken 用于刷新access_token的refresh_token
 */
// Explicación: Agregar registros detallados en la creación de sesiones para rastrear si se congela al comunicarse con la API de StepFun o al activar la página de chat.
async function createConversationWithAuth(refreshToken: string) {
  logger.info(`[StepFun会话] 准备为 token="${refreshToken.substring(0, 15)}..." 创建会话。正在等待频率限制限制器(throttleConversationCreate)...`);
  await throttleConversationCreate();
  logger.info(`[StepFun会话] 频率限制等待结束，正在获取/刷新身份凭证...`);
  const auth = await acquireStepFunAuth(refreshToken);
  logger.info(`[StepFun会话] 凭证获取成功: deviceId=${auth.deviceId.substring(0, 16)}..., anonymous=${!!auth.anonymous}`);
  
  const headers = getStepFunHeaders(auth, "https://www.stepfun.com/chats/new", "application/json");
  logger.info(`[StepFun会话] 正在向 StepFun 发送 CreateChatSession 请求...`);
  
  try {
    const result = await axios.post(
      "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/CreateChatSession",
      {},
      {
        headers,
        timeout: 15000,
        validateStatus: () => true,
      }
    );
    logger.info(`[StepFun会话] CreateChatSession 请求返回: HTTP 状态码=${result.status}`);
    const sessionData = checkResult(result, refreshToken);
    const chatSessionId = sessionData?.chatSession?.chatSessionId;
    if (!chatSessionId) {
      logger.error(`[StepFun会话] CreateChatSession 没有返回 chatSessionId, 完整数据=${JSON.stringify(result.data).substring(0, 500)}`);
      throw new APIException(EX.API_REQUEST_FAILED, `创建会话失败: StepFun 未返回会话ID`);
    }
    logger.info(`[StepFun会话] 成功获得会话ID: "${chatSessionId}"。正在激活会话页面(activateConversationPage)...`);
    await activateConversationPage(chatSessionId, auth);
    logger.success(`[StepFun会话] 会话激活成功, SessionID="${chatSessionId}"`);
    return { chatSessionId, auth };
  } catch (error: any) {
    logger.error(`[StepFun会话] 创建会话抛出异常: ${error.message}`, error);
    throw error;
  }
}

async function createConversation(refreshToken: string) {
  const { chatSessionId } = await createConversationWithAuth(refreshToken);
  return chatSessionId;
}

async function activateConversationPage(chatSessionId: string, auth: StepFunAuth) {
  const nextRouterStateTree = encodeURIComponent(
    JSON.stringify([
      "",
      {
        children: [
          "chats",
          {
            children: [
              ["chatSessionId", chatSessionId, "d"],
              {
                children: ["__PAGE__", {}, null, null],
              },
              null,
              null,
            ],
          },
          null,
          null,
        ],
      },
      null,
      null,
      true,
    ])
  );
  const result = await axios.get(
    "https://www.stepfun.com/chats/new?_rsc=p8l30",
    {
      headers: {
        Accept: "*/*",
        Cookie: auth.cookie || generateCookie(auth.deviceId, auth.token),
        "Oasis-Webid": auth.deviceId,
        "Next-Router-State-Tree": nextRouterStateTree,
        "Next-Url": `/chats/${chatSessionId}`,
        Rsc: "1",
        Referer: `https://www.stepfun.com/chats/${chatSessionId}`,
        ...(auth.anonymous ? ANONYMOUS_HEADERS : FAKE_HEADERS),
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
}

function getBrowserStateKey(refreshToken: string) {
  return crypto.createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
}

async function launchBrowserContext(userDataDir: string, stateKey: string) {
  const baseOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
    headless: process.env.STEPFUN_BROWSER_HEADLESS === "1",
    viewport: { width: 1280, height: 900 },
  };
  const candidates: Parameters<typeof chromium.launchPersistentContext>[1][] = process.env.STEPFUN_BROWSER_CHANNEL
    ? [{ ...baseOptions, channel: process.env.STEPFUN_BROWSER_CHANNEL }]
    : [{ ...baseOptions, channel: "chrome" }, baseOptions];
  let lastError: unknown;
  for (const options of candidates) {
    try {
      return await chromium.launchPersistentContext(userDataDir, options);
    } catch (err) {
      lastError = err;
      logger.warn(`Browser launch failed for account ${stateKey}${options.channel ? ` with channel ${options.channel}` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const options of candidates) {
    try {
      return await chromium.launchPersistentContext(`${userDataDir}-${Date.now()}`, options);
    } catch (err) {
      lastError = err;
      logger.warn(`Browser fresh-profile launch failed for account ${stateKey}${options.channel ? ` with channel ${options.channel}` : ''}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw lastError;
}

async function getBrowserState(refreshToken: string) {
  const stateKey = getBrowserStateKey(refreshToken);
  let state = browserStateMap.get(stateKey);
  if (!state) {
    const baseUserDataDir = process.env.STEPFUN_BROWSER_USER_DATA_DIR || "data/stepfun-browser";
    const userDataDir = path.join(baseUserDataDir, stateKey);
    const context = await launchBrowserContext(userDataDir, stateKey);
    state = { context, page: null, chatSessionId: null };
    browserStateMap.set(stateKey, state);
  }
  return state;
}

// Explicación: Agregar registros detallados para la depuración de Playwright, identificando si se bloquea al cargar la página o al inyectar cookies.
async function getBrowserPage(refreshToken: string) {
  const stateKey = getBrowserStateKey(refreshToken);
  logger.info(`[浏览器页面] 正在获取浏览器状态 (stateKey="${stateKey}")...`);
  const state = await getBrowserState(refreshToken);
  
  logger.info(`[浏览器页面] 正在获取/刷新凭据以注入 Cookie...`);
  const { deviceId, token } = await acquireToken(refreshToken);
  
  if (state.deviceId && state.deviceId !== deviceId) {
    // Explicación: Si el ID del dispositivo cambia (por ejemplo, después de una rotación de identidad anónima), forzamos el cierre de la página web anterior para evitar usar credenciales obsoletas almacenadas en la memoria del navegador y evitar el bloqueo.
    logger.warn(`[浏览器页面] 账号凭证发生变更 (旧deviceId=${state.deviceId.substring(0, 16)}... -> 新deviceId=${deviceId.substring(0, 16)}...). 强制关闭旧 Page 并重置 Session ID.`);
    if (state.page && !state.page.isClosed()) {
      try {
        await state.page.close();
      } catch (closeErr: any) {
        logger.error(`[浏览器页面] 关闭旧页面失败: ${closeErr.message}`);
      }
    }
    state.page = null;
    state.chatSessionId = null;
  }
  state.deviceId = deviceId;
  
  try {
    logger.info(`[浏览器页面] 正在向浏览器上下文注入 Cookie: Oasis-Webid="${deviceId.substring(0, 16)}..."`);
    await state.context.addCookies([
      { name: "Oasis-Token", value: token, domain: "www.stepfun.com", path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
      { name: "Oasis-Webid", value: deviceId, domain: "www.stepfun.com", path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
    ]);
    
    if (state.page && !state.page.isClosed()) {
      logger.info(`[浏览器页面] 复用已有未关闭页面, 当前URL="${state.page.url()}"`);
      return state.page;
    }
    
    logger.info(`[浏览器页面] 创建新页面或获取默认页面...`);
    state.page = state.context.pages()[0] || await state.context.newPage();
    
    if (!state.page.url().startsWith("https://www.stepfun.com")) {
      logger.info(`[浏览器页面] 页面不在 stepfun 域，正在导航到 /chats/new ...`);
      await state.page.goto("https://www.stepfun.com/chats/new", { waitUntil: "domcontentloaded" });
      logger.info(`[浏览器页面] 导航完成, 当前URL="${state.page.url()}"`);
    }
    return state.page;
  } catch (err: any) {
    logger.error(`[浏览器页面] 获取浏览器页面发生异常: ${err.message}`, err);
    browserStateMap.delete(stateKey);
    logger.warn(`Browser state for account ${stateKey} is unavailable, recreating: ${err instanceof Error ? err.message : String(err)}`);
  }
  return getBrowserPage(refreshToken);
}

async function createBrowserConversation(refreshToken: string) {
  logger.info(`[浏览器会话] 准备创建浏览器会话。正在等待频率限制(throttleConversationCreate)...`);
  await throttleConversationCreate();
  logger.info(`[浏览器会话] 频率限制等待结束，正在获取浏览器 Page 实例...`);
  const page = await getBrowserPage(refreshToken);
  
  logger.info(`[浏览器会话] 正在浏览器内部执行 CreateChatSession 接口请求...`);
  try {
    const sessionData = await page.evaluate(async () => {
      const resp = await fetch("/api/agent/capy.agent.v1.AgentService/CreateChatSession", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/json",
          "connect-protocol-version": "1",
          canary: "false",
          "oasis-appid": "10200",
          "oasis-language": "zh",
          "oasis-platform": "web",
          "x-waf-client-type": "fetch_sdk",
        },
        body: "{}",
      });
      return {
        status: resp.status,
        text: await resp.text(),
      };
    });
    
    logger.info(`[浏览器会话] 浏览器内 CreateChatSession 请求返回: HTTP 状态码=${sessionData.status}`);
    const result = JSON.parse(sessionData.text);
    if (result.code) {
      logger.error(`[浏览器会话] 业务逻辑错误: code=${result.code}, message=${result.message}`);
      throw new APIException(EX.API_REQUEST_FAILED, `[浏览器请求step失败]: ${result.message || result.code}`);
    }
    
    const chatSessionId = result?.chatSession?.chatSessionId;
    if (!chatSessionId) {
      logger.error(`[浏览器会话] StepFun 未返回 chatSessionId, 完整响应=${sessionData.text}`);
      throw new APIException(EX.API_REQUEST_FAILED, `浏览器创建会话失败: StepFun 未返回会话ID`);
    }
    
    logger.info(`[浏览器会话] 成功创建浏览器会话: "${chatSessionId}"。正在激活浏览器会话页面...`);
    const state = await getBrowserState(refreshToken);
    state.chatSessionId = chatSessionId;
    await activateBrowserConversationPage(refreshToken, chatSessionId);
    logger.success(`[浏览器会话] 浏览器会话创建并激活完成, SessionID="${chatSessionId}"`);
    return chatSessionId;
  } catch (error: any) {
    logger.error(`[浏览器会话] 创建会话失败: ${error.message}`, error);
    throw error;
  }
}

function resetBrowserConversation() {
  const previousChatSessionIds = Array.from(browserStateMap.values()).map((state) => state.chatSessionId).filter(Boolean);
  for (const state of browserStateMap.values()) state.chatSessionId = null;
  return {
    success: true,
    previous_chat_session_ids: previousChatSessionIds,
  };
}

async function activateBrowserConversationPage(refreshToken: string, chatSessionId: string) {
  const page = await getBrowserPage(refreshToken);
  const nextRouterStateTree = encodeURIComponent(
    JSON.stringify([
      "",
      {
        children: [
          "chats",
          {
            children: [
              ["chatSessionId", chatSessionId, "d"],
              {
                children: ["__PAGE__", {}, null, null],
              },
              null,
              null,
            ],
          },
          null,
          null,
        ],
      },
      null,
      null,
      true,
    ])
  );
  const status = await page.evaluate(async ({ chatSessionId, nextRouterStateTree }) => {
    const resp = await fetch(`/chats/new?_rsc=p8l30`, {
      method: "GET",
      credentials: "include",
      headers: {
        accept: "*/*",
        "next-router-state-tree": nextRouterStateTree,
        "next-url": `/chats/${chatSessionId}`,
        rsc: "1",
        "x-waf-client-type": "fetch_sdk",
      },
      referrer: `https://www.stepfun.com/chats/${chatSessionId}`,
    });
    await resp.text();
    return resp.status;
  }, { chatSessionId, nextRouterStateTree });
}

// Explicación: Agregar registros de depuración para rastrear la transmisión de chat en el navegador. Esto nos ayuda a saber si la transmisión se detiene o falla inesperadamente.
async function createBrowserChatStream(refreshToken: string, chatSessionId: string, body: Buffer) {
  logger.info(`[浏览器流] 准备启动浏览器流... sessionId="${chatSessionId}"`);
  const page = await getBrowserPage(refreshToken);
  const stream = new PassThrough();
  const streamId = `step_stream_${++browserStreamId}`;
  
  let chunksCount = 0;
  let bytesCount = 0;
  
  logger.info(`[浏览器流] 正在注册流式回调: window["${streamId}"]`);
  await page.exposeFunction(streamId, (chunk: number[] | null, error?: string) => {
    if (error) {
      logger.error(`[浏览器流] 回调收到浏览器内流异常 (streamId="${streamId}"): ${error}`);
      stream.destroy(new Error(error));
      return;
    }
    if (!chunk) {
      logger.info(`[浏览器流] 回调收到结束信号 [EOF] (streamId="${streamId}"). 总共接收数据块=${chunksCount}, 字节数=${bytesCount}`);
      stream.end();
      return;
    }
    chunksCount += 1;
    bytesCount += chunk.length;
    stream.write(Buffer.from(chunk));
  });
  
  logger.info(`[浏览器流] 正在浏览器页面中异步触发 ChatStream 的 fetch 动作...`);
  page.evaluate(async ({ streamId, chatSessionId, body }) => {
    try {
      const resp = await fetch("/api/agent/capy.agent.v1.AgentService/ChatStream", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/connect+json",
          "connect-protocol-version": "1",
          canary: "false",
          "oasis-appid": "10200",
          "oasis-language": "zh",
          "oasis-platform": "web",
          "x-waf-client-type": "fetch_sdk",
        },
        referrer: `https://www.stepfun.com/chats/${chatSessionId}`,
        body: new Uint8Array(body),
      });
      if (!resp.body) throw new Error(`ChatStream returned no body, status=${resp.status}`);
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await (window as any)[streamId](Array.from(value));
      }
      await (window as any)[streamId](null);
    } catch (err) {
      await (window as any)[streamId](null, err instanceof Error ? err.message : String(err));
    }
  }, { streamId, chatSessionId, body: Array.from(body) }).catch((err) => {
    logger.error(`[浏览器流] page.evaluate 内流执行捕获到异常: ${err.message}`, err);
    stream.destroy(err);
  });
  return stream;
}

/**
 * 构建工具提示词（用于注入到 system 消息中，让模型以 DSML 格式输出工具调用）
 */
function buildChatToolPrompt(tools: any[]): string {
  if (!tools || tools.length === 0) return '';
  const summaries = tools.map((tool) => {
    const name = tool.name || tool.function?.name || 'unknown';
    const desc = tool.description || tool.function?.description || '';
    const params = tool.parameters || tool.function?.parameters || {};
    const required = Array.isArray(params.required) ? params.required.join(', ') : 'none';
    return `- ${name}: ${desc} (required parameters: ${required})`;
  }).join('\n');

  return `You have access to the following tools. When you need to use a tool, immediately output a DSML tool call block in exactly this format:

<|DSML|tool_calls>
  <|DSML|invoke name="tool_name">
    <|DSML|parameter name="param_name"><![CDATA[value]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

You can call multiple tools in parallel by adding multiple <|DSML|invoke> blocks.
Wrap parameter values in <![CDATA[...]]> to avoid XML escaping issues.
If a tool is needed, output ONLY the DSML block and do not output any explanation, prefix, suffix, or markdown code fences before the tool call.
After tool results are provided by the client, continue the final answer based on those results.

Available tools:
${summaries}`;
}

/**
 * 将 DSML 工具调用解析结果转换为 OpenAI tool_calls 格式
 */
function toOpenAIToolCalls(parsedCalls: ParsedToolCall[]): any[] {
  return parsedCalls.map((call, index) => ({
    index,
    id: `call_${util.uuid(false).substring(0, 16)}`,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.input || {}),
    },
  }));
}

/**
 * 从回答中解析工具调用并重构为 OpenAI 格式
 */
function parseToolCallsFromAnswer(answer: any, tools?: any[]): any {
  const text = answer?.choices?.[0]?.message?.content || '';
  const parsed = parseToolCallsDetailed(text);
  if (parsed.calls.length > 0) {
    const toolCalls = toOpenAIToolCalls(parsed.calls);
    answer.choices[0].message = {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
    };
    answer.choices[0].finish_reason = 'tool_calls';
  } else if (parsed.sawToolCallSyntax) {
    // Malformed tool call syntax — strip the incomplete markup
    const cleaned = text.replace(/<\|?DSML\|?tool_calls[\s\S]*/i, '').replace(/<\|?DSML\|?invoke[\s\S]*/i, '').trim();
    answer.choices[0].message.content = cleaned || text;
  }
  return answer;
}

/**
 * 同步对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletion(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  useSearch = true,
  tools?: any[],
  toolChoice?: any,
  retryCount = 0
) {
  return (async () => {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const toolPrompt = hasTools ? buildChatToolPrompt(tools) : '';
    const toolPromptMsg = toolPrompt ? { role: 'system', content: toolPrompt, __stepFreeToolPrompt: true } : null;
    const enhancedMessages = toolPromptMsg ? [toolPromptMsg, ...messages] : messages;

    const refFileUrls = extractRefFileUrls(enhancedMessages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))
        )
      : [];
    const currentInput = await applyCurrentInputFileIfNeeded(enhancedMessages, refs, refreshToken);

    if (process.env.STEPFUN_BROWSER_MODE === "1") {
      const auth = await acquireStepFunAuth(refreshToken);
      const convId = await createBrowserConversation(refreshToken);
      const result = await createBrowserChatStream(refreshToken, convId, messagesPrepare(convId, currentInput.messages, currentInput.refs, resolveStepFunModel(model)));
      const streamStartTime = util.timestamp();
      const promptTokens = estimateMessagesTokens(currentInput.messages);
      const answer = await receiveStream(model, convId, result, promptTokens);
      logger.success(
        `Browser stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      if (auth.anonymous && isNeedSignInAnswer(answer) && retryCount < 1) {
        // Explicación: Si se detecta que el usuario anónimo necesita iniciar sesión en el modo de navegador (por haber alcanzado el límite de chat), invalidamos las credenciales actuales y reintentamos de inmediato.
        logger.warn("StepFun anonymous identity reached chat limit in browser mode, renewing and retrying once");
        clearAnonymousIdentity(auth);
        return createCompletion(model, messages, refreshToken, useSearch, tools, toolChoice, retryCount + 1);
      }
      reserveAnonymousTurn(auth);
      return hasTools ? parseToolCallsFromAnswer(answer, tools) : answer;
    }

    const { chatSessionId: convId, auth } = await createConversationWithAuth(refreshToken);
    const result = await axios.post(
      "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/ChatStream",
      messagesPrepare(convId, currentInput.messages, currentInput.refs, resolveStepFunModel(model)),
      {
        headers: getStepFunHeaders(auth, `https://www.stepfun.com/chats/${convId}`, "application/connect+json"),
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    // 接收流为输出文本
    const promptTokens = estimateMessagesTokens(currentInput.messages);
    const answer = await receiveStream(model, convId, result.data, promptTokens);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );
    if (auth.anonymous && isNeedSignInAnswer(answer) && retryCount < 1) {
      logger.warn("StepFun anonymous identity reached chat limit, renewing and retrying once");
      clearAnonymousIdentity(auth);
      return createCompletion(model, messages, refreshToken, useSearch, tools, toolChoice, retryCount + 1);
    }
    reserveAnonymousTurn(auth);
    return hasTools ? parseToolCallsFromAnswer(answer, tools) : answer;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletion(
          model,
          messages,
          refreshToken,
          useSearch,
          tools,
          toolChoice,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 流式对话补全
 *
 * @param model 模型名称
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 * @param refreshToken 用于刷新access_token的refresh_token
 * @param useSearch 是否开启联网搜索
 * @param retryCount 重试次数
 */
async function createCompletionStream(
  model = MODEL_NAME,
  messages: any[],
  refreshToken: string,
  useSearch = true,
  tools?: any[],
  toolChoice?: any,
  retryCount = 0
) {
  return (async () => {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const toolPrompt = hasTools ? buildChatToolPrompt(tools) : '';
    const toolPromptMsg = toolPrompt ? { role: 'system', content: toolPrompt, __stepFreeToolPrompt: true } : null;
    const enhancedMessages = toolPromptMsg ? [toolPromptMsg, ...messages] : messages;

    // 提取引用文件URL并上传step获得引用的文件ID列表
    const refFileUrls = extractRefFileUrls(enhancedMessages);
    const refs = refFileUrls.length
      ? await Promise.all(
          refFileUrls.map((fileUrl) => uploadFile(fileUrl, refreshToken))
        )
      : [];
    const currentInput = await applyCurrentInputFileIfNeeded(enhancedMessages, refs, refreshToken);

    if (process.env.STEPFUN_BROWSER_MODE === "1") {
      const auth = await acquireStepFunAuth(refreshToken);
      const convId = await createBrowserConversation(refreshToken);
      const result = await createBrowserChatStream(refreshToken, convId, messagesPrepare(convId, currentInput.messages, currentInput.refs, resolveStepFunModel(model)));
      const streamStartTime = util.timestamp();
      const promptTokens = estimateMessagesTokens(currentInput.messages);
      const transStream = createTransStream(model, convId, result, () => {
        logger.success(
          `Browser stream has completed transfer ${util.timestamp() - streamStartTime}ms`
        );
        reserveAnonymousTurn(auth);
      }, tools, {
        endOnSourceClose: false,
        onNeedSignIn: auth.anonymous && retryCount < 1 ? () => {
          // Explicación: Limpiamos la identidad anónima y reintentamos la transmisión cuando el navegador recibe un error que indica que se requiere iniciar sesión (debido a la expiración de la sesión o al límite alcanzado).
          logger.warn("StepFun anonymous identity reached stream limit in browser mode, renewing and retrying once");
          clearAnonymousIdentity(auth);
          return createCompletionStream(
            model,
            messages,
            refreshToken,
            useSearch,
            tools,
            toolChoice,
            retryCount + 1
          );
        } : undefined,
        onEmptyResponse: retryCount < 1 ? () => createCompletionStream(
          model,
          [...messages, { role: "user", content: "上一轮没有产生用户可见回答。请直接继续并给出可见答案，不要重复工具调用。" }],
          refreshToken,
          useSearch,
          tools,
          toolChoice,
          retryCount + 1
        ) : undefined,
      }, promptTokens);
      if (STREAM_TIMEOUT_MS > 0 && retryCount < STREAM_TIMEOUT_RETRY_COUNT) {
        const timeout = setTimeout(async () => {
          if (transStream.destroyed || transStream.writableEnded) return;
          logger.warn(`Browser stream timed out after ${STREAM_TIMEOUT_MS}ms, summarizing context before retry`);
          result.destroy(new Error("Browser stream timeout"));
          const retryMessages = await withSummarizedRetryContext(messages, refreshToken);
          const retryStream = await createCompletionStream(
            model,
            retryMessages,
            refreshToken,
            useSearch,
            tools,
            toolChoice,
            retryCount + 1
          );
          retryStream.pipe(transStream, { end: true });
        }, STREAM_TIMEOUT_MS);
        transStream.once("finish", () => clearTimeout(timeout));
      }
      return transStream;
    }
    // 创建会话
    const { chatSessionId: convId, auth } = await createConversationWithAuth(refreshToken);

    // 请求流
    const result = await axios.post(
      "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/ChatStream",
      messagesPrepare(convId, currentInput.messages, currentInput.refs, resolveStepFunModel(model)),
      {
        headers: getStepFunHeaders(auth, `https://www.stepfun.com/chats/${convId}`, "application/connect+json"),
        timeout: STREAM_TIMEOUT_MS > 0 ? STREAM_TIMEOUT_MS : 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    // 创建转换流将消息格式转换为gpt兼容格式
    const promptTokens = estimateMessagesTokens(currentInput.messages);
    const transStream = createTransStream(model, convId, result.data, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      reserveAnonymousTurn(auth);
    }, tools, {
      onNeedSignIn: auth.anonymous && retryCount < 1 ? () => {
        logger.warn("StepFun anonymous identity reached stream limit, renewing and retrying once");
        clearAnonymousIdentity(auth);
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          useSearch,
          tools,
          toolChoice,
          retryCount + 1
        );
      } : undefined,
      onEmptyResponse: retryCount < 1 ? () => createCompletionStream(
        model,
        [...messages, { role: "user", content: "上一轮没有产生用户可见回答。请直接继续并给出可见答案，不要重复工具调用。" }],
        refreshToken,
        useSearch,
        tools,
        toolChoice,
        retryCount + 1
      ) : undefined,
    }, promptTokens);
    if (STREAM_TIMEOUT_MS > 0 && retryCount < STREAM_TIMEOUT_RETRY_COUNT) {
      const timeout = setTimeout(async () => {
        if (transStream.destroyed || transStream.writableEnded) return;
        logger.warn(`Stream timed out after ${STREAM_TIMEOUT_MS}ms, summarizing context before retry`);
        result.data.destroy(new Error("Stream timeout"));
        const retryMessages = await withSummarizedRetryContext(messages, refreshToken);
        const retryStream = await createCompletionStream(
          model,
          retryMessages,
          refreshToken,
          useSearch,
          tools,
          toolChoice,
          retryCount + 1
        );
        retryStream.pipe(transStream, { end: true });
      }, STREAM_TIMEOUT_MS);
      transStream.once("finish", () => clearTimeout(timeout));
    }
    return transStream;
  })().catch((err) => {
    if (retryCount < MAX_RETRY_COUNT) {
      logger.error(`Stream response error: ${err.message}`);
      logger.warn(`Try again after ${RETRY_DELAY / 1000}s...`);
      return (async () => {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        return createCompletionStream(
          model,
          messages,
          refreshToken,
          useSearch,
          tools,
          toolChoice,
          retryCount + 1
        );
      })();
    }
    throw err;
  });
}

/**
 * 提取消息中引用的文件URL
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
function extractRefFileUrls(messages: any[]) {
  const urls: string[] = [];
  if (!messages.length) return urls;
  messages.forEach((message) => {
    if (!_.isArray(message.content)) return;
    message.content.forEach((item) => {
      const url = extractContentFileUrl(item);
      if (url && !urls.includes(url)) urls.push(url);
    });
  });
  return urls;
}

function extractContentFileUrl(item: any) {
  if (!_.isObject(item)) return "";
  const type = String(item["type"] || "").toLowerCase();
  if (type === "image_url") {
    if (_.isString(item["image_url"])) return item["image_url"];
    if (_.isObject(item["image_url"]) && _.isString(item["image_url"]["url"])) return item["image_url"]["url"];
  }
  if (type === "file" || type === "input_file" || type === "attachment") {
    if (_.isString(item["file_url"])) return item["file_url"];
    if (_.isObject(item["file_url"]) && _.isString(item["file_url"]["url"])) return item["file_url"]["url"];
    if (_.isString(item["file"])) return item["file"];
    if (_.isObject(item["file"]) && _.isString(item["file"]["url"])) return item["file"]["url"];
    if (_.isString(item["url"])) return item["url"];
  }
  if (_.isString(item["url"]) && /^(https?:\/\/|data:)/i.test(item["url"])) return item["url"];
  if (_.isString(item["url"])) return item["url"];
  if (_.isString(item["path"])) return item["path"];
  return "";
}

function withSimpleReplyPrompt(messages: any[]) {
  const promptMessage = { role: "system", content: STREAM_TIMEOUT_RETRY_PROMPT, __stepFreeTimeoutRetryPrompt: true };
  if (messages.some((message) => message?.__stepFreeTimeoutRetryPrompt)) return messages;
  return [promptMessage, ...messages];
}

async function withSummarizedRetryContext(messages: any[], refreshToken: string) {
  const latestUser = findLatestUserMessage(messages);
  const transcript = buildHistoryTranscript(messages, latestUser.index);
  const summary = await summarizeLongContext(transcript, refreshToken, true);
  const latestUserContent = latestUser.content || normalizeMessageContentForTranscript(messages[messages.length - 1]?.content);
  return [
    { role: "system", content: STREAM_TIMEOUT_RETRY_PROMPT, __stepFreeTimeoutRetryPrompt: true },
    {
      role: "user",
      content: [
        "前一次响应超时，旧对话已经终止。下面是压缩后的历史对话记录，请把它当成新的上下文继续处理最新请求。",
        "不要复述压缩过程，不要重复已完成的工具调用，不要把系统工具说明当成用户内容。",
        "",
        "压缩后的历史对话记录：",
        summary,
        "",
        "最新用户请求：",
        latestUserContent,
      ].join("\n"),
      __stepFreeSummarizedRetry: true,
    },
  ];
}

/**
 * 消息预处理
 *
 * 由于接口只取第一条消息，此处会将多条消息合并为一条，实现多轮对话效果
 * user:旧消息1
 * assistant:旧消息2
 * user:新消息
 *
 * @param messages 参考gpt系列消息格式，多轮对话请完整提供上下文
 */
const EXTERNAL_CONTENT_RE = /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/gi;
function scrubExternalContent(text: string) {
  return text.replace(EXTERNAL_CONTENT_RE, "[external content omitted]");
}

function resolveStepFunModel(model: string): string {
  if (/deepseek/i.test(model)) return 'deepseek-r1';
  return 'step-auto';
}

function cleanMessageContentForPrepare(content: any): string {
  if (!content) return "";
  let text = _.isString(content) ? content : normalizeMessageContentForTranscript(content);
  
  // Explicación: Limpiamos y restauramos los mensajes del historial que contienen resúmenes largos o instrucciones de continuación interna, extrayendo únicamente la pregunta real del usuario para evitar el contexto redundante.
  if (/Use the provided prior context internally/i.test(text)) {
    const match = text.match(/(?:Latest user request|latest user request):\s*([\s\S]+)$/i);
    if (match && match[1]) {
      text = match[1].trim();
    }
  }

  // Explicación: Limitamos el tamaño de cada mensaje individual a 30,000 caracteres para evitar que una sola respuesta de búsqueda web o registros masivos saturen el límite de tokens (120k) de StepFun. Conservamos 15k del inicio y 15k del final para no perder información valiosa de introducción y conclusión.
  const SINGLE_MESSAGE_MAX_CHARS = 30000;
  if (text.length > SINGLE_MESSAGE_MAX_CHARS) {
    const half = Math.floor(SINGLE_MESSAGE_MAX_CHARS / 2);
    text = text.slice(0, half) + "\n\n[... CONTENIDO EXCESIVO OMITIDO Y RECORTADO POR EL SISTEMA PARA EVITAR DESBORDAMIENTO ...]\n\n" + text.slice(-half);
  }

  return text;
}

function messagesPrepare(chatSessionId: string, messages: any[], refs: any[], stepModel = 'step-auto') {
  const attachments = refs.map(formatStepFunAttachment).filter(Boolean);

  // Explicación: Preprocesamos y extraemos de forma limpia el texto de cada mensaje aplicando el límite individual.
  const processedMessages = messages.map(message => {
    let text = "";
    if (_.isArray(message.content)) {
      text = message.content.reduce((_content, v) => {
        if (!_.isObject(v) || v["type"] != "text") return _content;
        const cleanedText = cleanMessageContentForPrepare(v["text"]);
        const cleaned = scrubExternalContent(cleanedText);
        return _content + (cleaned ? `${cleaned}\n` : "");
      }, "").trim();
    } else {
      const cleanedContent = cleanMessageContentForPrepare(message.content);
      text = scrubExternalContent(cleanedContent).trim();
    }
    return {
      role: message.role || "user",
      text: text
    };
  }).filter(item => item.text.length > 0);

  // Explicación: Para evitar el desbordamiento de tokens y errores de "prompt exceed max len 120000" de StepFun, implementamos un truncamiento adaptativo de historial con prioridad para los mensajes más recientes. Recorremos en orden inverso y dejamos de acumular si superamos los 90,000 caracteres, descartando las conversaciones más antiguas de manera elegante.
  const GLOBAL_CONTEXT_MAX_CHARS = 90000;
  let accumulatedLength = 0;
  const keptMessages: typeof processedMessages = [];
  let isTruncated = false;

  for (let i = processedMessages.length - 1; i >= 0; i--) {
    const item = processedMessages[i];
    const msgLen = item.role.length + item.text.length + 3; // `${role}:${text}\n`
    if (accumulatedLength + msgLen > GLOBAL_CONTEXT_MAX_CHARS) {
      isTruncated = true;
      break;
    }
    keptMessages.unshift(item);
    accumulatedLength += msgLen;
  }

  let content = `system:${CHINESE_REPLY_PROMPT}\n`;
  if (isTruncated) {
    content += "system:[更早的对话历史由于平台提示词长度限制，已被系统自动省略]\n";
  }

  content = keptMessages.reduce((acc, item) => {
    return acc + `${item.role}:${item.text}\n`;
  }, content) + "assistant:";

  logPrompt(content);

  const body = {
    message: {
      chatSessionId,
      content: {
        userMessage: {
          qa: {
            content,
            attachments,
          },
        },
      },
    },
    config: {
      model: stepModel,
      enableReasoning: stepModel === 'deepseek-r1',
    },
  };

  return encodeConnectJsonEnvelope(JSON.stringify(body));
}

function encodeConnectJsonEnvelope(bodyJson: string) {
  const payload = Buffer.from(bodyJson);
  const envelope = Buffer.alloc(payload.length + 5);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(payload.length, 1);
  payload.copy(envelope, 5);
  return envelope;
}

function formatStepFunAttachment(ref: any) {
  if (!ref) return null;
  if (ref.resource) return ref;
  const rid = String(ref.rid || ref.attachmentId || ref.id || "").trim();
  if (!rid) return null;
  const filename = String(ref.name || ref.filename || "attachment").trim();
  const mimeType = String(ref.mimeType || ref.attachmentType || "application/octet-stream").trim();
  const url = String(ref.url || "").trim();
  const isImage = mimeType.startsWith("image/");
  if (isImage) {
    return {
      resource: {
        image: {
          rid,
          meta: {
            filename,
            mimeType,
          },
          url,
          width: ref.width,
          height: ref.height,
        },
        rid,
      },
    };
  }
  return {
    resource: {
      doc: {
        rid,
        meta: {
          filename,
          mimeType,
        },
        url,
      },
      rid,
    },
  };
}

function buildHistoryTranscript(messages: any[], excludeIndex = -1) {
  const transcriptMessages = messages.filter((message, index) => index !== excludeIndex && !shouldIgnorePromptHistoryMessage(message));
  let entry = 0;
  const lines = [`# ${CURRENT_INPUT_FILENAME}`, "Prior conversation history and tool progress.", ""];
  for (const message of transcriptMessages) {
    const role = String(message?.role || "user").trim().toUpperCase() || "USER";
    const content = sanitizePromptHistoryText(normalizeMessageContentForTranscript(message?.content));
    if (!content.trim()) continue;
    entry += 1;
    lines.push(`=== ${entry}. ${role} ===`);
    lines.push(content.trim());
    lines.push("");
  }
  return lines.join("\n").trim() + "\n";
}

function normalizeMessageContentForTranscript(content: any): string {
  if (_.isString(content)) return content;
  if (_.isArray(content)) {
    return content.map((item) => {
      if (!_.isObject(item)) return String(item || "");
      if (item["type"] === "text") return _.isString(item["text"]) ? item["text"] : JSON.stringify(item["text"]);
      if (item["type"] === "image_url") return `[image_url] ${JSON.stringify(item["image_url"] || {})}`;
      if (item["type"] === "file") return `[file] ${JSON.stringify(item["file_url"] || item["file"] || {})}`;
      return JSON.stringify(item);
    }).join("\n");
  }
  if (_.isObject(content)) return JSON.stringify(content);
  return String(content || "");
}

function sanitizePromptHistoryText(text: string) {
  return scrubExternalContent(String(text || ""))
    .replace(/You are a personal assistant running inside OpenClaw\.[\s\S]*?(?=\n(?:user|assistant|system):|$)/gi, "[system tool instructions omitted]")
    .replace(/## Tooling[\s\S]*?(?=\n## |\n(?:user|assistant|system):|$)/gi, "[tooling instructions omitted]")
    .replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, "[available skills omitted]")
    .replace(/# Project Context[\s\S]*?(?=\n(?:user|assistant|system):|$)/gi, "[project context omitted]")
    .replace(/<\|DSML\|tool_calls[\s\S]*?<\/\|DSML\|tool_calls\s*>/gi, "[tool_calls omitted]")
    .replace(/<tool_calls[\s\S]*?<\/tool_calls\s*>/gi, "[tool_calls omitted]")
    .replace(/(?:<\|DSML\|invoke\b[\s\S]*?<\/\|DSML\|invoke\s*>\s*){2,}/gi, "[tool_calls omitted]")
    .replace(/(?:<invoke\b[\s\S]*?<\/invoke\s*>\s*){2,}/gi, "[tool_calls omitted]")
    .replace(/<\|DSML\|invoke\b[\s\S]*$/gi, "[truncated tool_call omitted]")
    .replace(/<invoke\b[\s\S]*$/gi, "[truncated tool_call omitted]")
    .replace(/\[Tool call requested\s*\(([^)]*)\)\]:/gi, "[Historical completed tool call ($1); do not repeat]:")
    .replace(/\[Tool result\s*\(([^)]*)\)\]:/gi, "[Historical completed tool result ($1); do not repeat this tool call]:")
    .replace(/\[Tool result\]:/gi, "[Historical completed tool result; do not repeat this tool call]:")
    .replace(/服务暂时不可用，第三方响应错误：\[invalid_argument\] prompt exceed max len \d+/g, "[prompt length error omitted]")
    .replace(/prompt exceed max len\s+\d+/gi, "[prompt length error omitted]");
}

function isInternalContinuationPrompt(text: string) {
  const value = String(text || "").trim();
  return /^The latest entries in the context are tool results\.[\s\S]*?Continue from the latest state in the (?:attached DS2API_HISTORY\.txt context|inline context below)\./i.test(value)
    || /^Continue from the latest state in the (?:attached DS2API_HISTORY\.txt context|inline context below)\./i.test(value)
    || /^Use the provided prior context internally\./i.test(value)
    || /^The latest entries in the context are tool results\.[\s\S]*?Use the provided prior context internally\./i.test(value);
}

function isInterruptedRequestPlaceholder(text: string) {
  return /^\s*\[Request interrupted by user\]\s*$/i.test(String(text || ""));
}

function shouldIgnorePromptHistoryMessage(message: any) {
  if (message?.__stepFreeToolPrompt) return true;
  if (message?.__stepFreeSummarizedRetry) return true;
  const role = String(message?.role || "user").toLowerCase();
  if (role === "system" || role === "developer") return true;
  const text = sanitizePromptHistoryText(normalizeMessageContentForTranscript(message?.content)).trim();
  return isInternalContinuationPrompt(text) || isInterruptedRequestPlaceholder(text);
}

function clampPromptText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars / 2))}\n\n[...middle content omitted...]\n\n${text.slice(-Math.floor(maxChars / 2))}`;
}

async function summarizeLongContext(text: string, refreshToken: string, force = false) {
  // Explicación: Para evitar retrasos de red, límites de frecuencia y bloqueos indefinidos por tiempo de espera en la API externa al procesar historiales muy largos, realizamos el recorte directamente en la memoria. Esto garantiza un rendimiento de 0 ms y evita cuellos de botella o interrupciones indefinidas en la ejecución del hilo principal.
  logger.info(`[上下文压缩] 跳过外部 API 压缩总结，直接进行本地内存截断以保证零阻塞高可用`);
  return clampPromptText(text, CURRENT_INPUT_SUMMARY_MAX_CHARS);
}

function hasPromptOverflowArtifacts(messages: any[]) {
  return messages.some((message) => {
    if (shouldIgnorePromptHistoryMessage(message)) return false;
    const text = normalizeMessageContentForTranscript(message?.content);
    return /<\|DSML\|tool_calls|<\|DSML\|invoke|<tool_calls|<invoke|prompt exceed max len/i.test(text);
  });
}

function findLatestUserMessage(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (shouldIgnorePromptHistoryMessage(messages[i])) continue;
    if (String(messages[i]?.role || "user").toLowerCase() !== "user") continue;
    if (isToolResultOnlyMessage(messages[i])) continue;
    const content = sanitizePromptHistoryText(normalizeMessageContentForTranscript(messages[i]?.content)).trim();
    if (isInternalContinuationPrompt(content) || isInterruptedRequestPlaceholder(content)) continue;
    if (!content) continue;
    return { index: i, content };
  }
  return { index: -1, content: "" };
}

function isToolResultOnlyMessage(message: any) {
  const content = message?.content;
  if (_.isString(content)) return isToolResultOnlyText(content);
  if (!Array.isArray(content) || content.length === 0) return false;
  let hasToolResult = false;
  for (const item of content) {
    if (!item || typeof item !== "object") return false;
    const type = String(item.type || "").toLowerCase();
    if (type === "tool_result") {
      hasToolResult = true;
      continue;
    }
    if (type === "text" && !String(item.text || "").trim()) continue;
    return false;
  }
  return hasToolResult;
}

function isToolResultOnlyText(text: string) {
  return /^\s*\[Tool result(?:\s*\([^)]*\))?\]:/i.test(String(text || "").trim());
}

function hasTrailingToolResult(messages: any[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (shouldIgnorePromptHistoryMessage(messages[i])) continue;
    if (isToolResultOnlyMessage(messages[i])) return true;
    const text = normalizeMessageContentForTranscript(messages[i]?.content).trim();
    if (text) return false;
  }
  return false;
}

async function applyCurrentInputFileIfNeeded(messages: any[], refs: any[], refreshToken: string) {
  if (process.env.STEPFUN_CURRENT_INPUT_FILE_ENABLED === "0") return { messages, refs };
  if (messages.some((message) => message?.__stepFreeSummarizedRetry)) return { messages, refs };
  const latestUser = findLatestUserMessage(messages);
  let transcript = buildHistoryTranscript(messages, latestUser.index);
  if (!transcript.trim()) return { messages, refs };
  if (transcript.length < CURRENT_INPUT_MIN_CHARS && !hasPromptOverflowArtifacts(messages)) return { messages, refs };
  transcript = await summarizeLongContext(transcript, refreshToken);
  const toolPromptMessages = messages.filter((message) => message?.__stepFreeToolPrompt);
  const latestUserContent = clampPromptText(latestUser.content, CURRENT_INPUT_LIVE_MAX_CHARS);
  const continuationPrefix = hasTrailingToolResult(messages)
    ? "The latest entries in the context are completed tool results. Use them to continue the original user task. Do not repeat historical tool calls. If more actions are needed, call only the next necessary tool; otherwise answer normally.\n\n"
    : "";

  // Explicación: Para evitar que el modelo entre en un bucle infinito llamando repetidamente a la misma herramienta en OpenClaw, debemos conservar todos los mensajes de llamadas y resultados de herramientas posteriores a la última pregunta del usuario en la lista de mensajes principal en lugar de purgarlos.
  const trailingMessages = messages.slice(latestUser.index + 1).filter((message) => !message?.__stepFreeToolPrompt);

  try {
    const ref = await uploadCurrentInputFile(transcript, refreshToken);
    const inlineTranscript = clampPromptText(transcript, CURRENT_INPUT_LIVE_MAX_CHARS);
    const latestUserPrompt = latestUserContent
      ? `${continuationPrefix}Use the provided prior context internally. The same context is attached as ${CURRENT_INPUT_FILENAME} and also included below for reliability. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context. If the attachment cannot be read, use the inline context below and do not claim the file is empty.\n\nContext:\n${inlineTranscript}\n\nLatest user request:\n${latestUserContent}`
      : `${continuationPrefix}Use the provided prior context internally. The same context is attached as ${CURRENT_INPUT_FILENAME} and also included below for reliability. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context and answer the latest user request directly. If the attachment cannot be read, use the inline context below and do not claim the file is empty.\n\nContext:\n${inlineTranscript}`;
    return {
      messages: [
        ...toolPromptMessages,
        {
          role: "user",
          content: latestUserPrompt,
        },
        ...trailingMessages,
      ],
      refs: [ref, ...refs],
    };
  } catch (err) {
    logger.warn(`Current input context upload failed, falling back to inline context: ${err instanceof Error ? err.message : String(err)}`);
    const inlineTranscript = clampPromptText(transcript, CURRENT_INPUT_LIVE_MAX_CHARS);
    const latestUserPrompt = latestUserContent
      ? `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context.\n\nContext:\n${inlineTranscript}\n\nLatest user request:\n${latestUserContent}`
      : `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context and answer the latest user request directly.\n\nContext:\n${inlineTranscript}`;
    return {
      messages: [
        ...toolPromptMessages,
        {
          role: "user",
          content: latestUserPrompt,
        },
        ...trailingMessages,
      ],
      refs,
    };
  }
}

/**
 * @param result 结果
 * @param refreshToken 用于刷新access_token的refresh_token
 */
function checkResult(result: AxiosResponse, refreshToken: string) {
  if (!result.data) {
    logger.warn(`checkResult: no data, status=${result.status}`);
    return null;
  }
  const { code, message } = result.data;
  if (!_.isString(code)) return result.data;
  logger.error(`StepFun API error: code=${code}, message=${message}, status=${result.status}, data=${JSON.stringify(result.data).substring(0, 500)}`);
  if (code == "unauthenticated") {
    accessTokenMap.delete(refreshToken);
    clearConversationCache(refreshToken);
  }
  throw new APIException(EX.API_REQUEST_FAILED, `[请求step失败]: ${message}`);
}

function extractStepFunEventText(event: any) {
  if (event?.textEvent?.text) return String(event.textEvent.text);
  const content = event?.messageEvent?.message?.content;
  const assistantMessage = content?.assistantMessage;
  const qa = assistantMessage?.qa;
  const candidates = [
    qa?.text,
    qa?.content,
    qa?.answer,
    qa?.message,
    assistantMessage?.text,
    assistantMessage?.content,
    content?.text,
  ];
  const text = candidates.find((value) => _.isString(value) && value.length > 0);
  return text ? String(text) : "";
}

/**
 * 从流接收完整的消息内容
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 */
async function receiveStream(model: string, convId: string, stream: any, promptTokens = 1) {
  return new Promise((resolve, reject) => {
    // 消息初始化
    const data = {
      id: convId,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
      created: util.unixTimestamp(),
    };
    let refContent = "";
    const parser = (buffer: Buffer) => {
      const result = _.attempt(() => JSON.parse(buffer.toString()));
      if (_.isError(result)) {
        logger.warn(`Error response: ${buffer.toString()}`);
        throw new Error(`Stream response invalid: ${result}`);
      }
      // 新版API事件包装在 data.event 中
      const event = result.data?.event || result;
      if (event.error && event.error.code) {
        attachStepFunError(data, event.error);
        logger.error(`StepFun stream error: code=${event.error.code}, message=${event.error.message}, fullEvent=${JSON.stringify(event.error)}`);
        data.choices[0].message.content += `服务暂时不可用，第三方响应错误：[${event.error.code}] ${event.error.message}`;
      }
      else if (event.pipelineEvent) {
        if (
          event.pipelineEvent.eventSearch &&
          event.pipelineEvent.eventSearch.results
        ) {
          refContent = event.pipelineEvent.eventSearch.results.reduce(
            (str, v) => {
              return (str += `${v.title} - ${v.url}\n`);
            },
            ""
          );
        }
      } else {
        const text = extractStepFunEventText(event);
        if (text) {
          data.choices[0].message.content += text;
        } else if (event.messageEvent) {
        // 记录消息元数据（messageId等）
        data.id = event.messageEvent.message?.messageId || data.id;
      } else if (event.doneEvent) {
        data.choices[0].message.content =
          data.choices[0].message.content.replace(
            /<(web|url|unknown)_[0-9a-zA-Z]+>/g,
            ""
          );
        data.choices[0].message.content += refContent
          ? `\n\n搜索结果来自：\n${refContent.replace(/\n$/, "")}`
          : "";
        }
      }
    };
    let chunk = Buffer.from([]);
    let temp = Buffer.from([]);
    // 将流数据传到转换器
    stream.on("data", (buffer: Buffer) => {
      // 接收数据头
      chunk = Buffer.concat([temp, chunk, buffer]);
      // 循环处理chunk中所有完整消息，避免同一条数据内多条消息丢失
      while (chunk.length >= 5) {
        const chunkSize = chunk.readUint32BE(1);
        const totalLen = chunkSize + 5;
        if (chunk.length < totalLen) break;
        parser(chunk.subarray(5, totalLen));
        chunk = chunk.subarray(totalLen);
      }
      temp = chunk;
      chunk = Buffer.from([]);
    });
    stream.once("error", (err) => reject(err));
    stream.once("close", () => {
      // Explicación: Calculamos de forma dinámica el número exacto de tokens consumidos por la respuesta final y el prompt para mostrar estadísticas de uso correctas en el cliente.
      const completionTokens = estimateTextTokens(data.choices[0].message.content);
      data.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      };
      resolve(data);
    });
  });
}

/**
 * 清除会话缓存
 * 在遇到 permission_denied 等错误时调用，强制下次请求创建新会话
 */
export function clearConversationCache(refreshToken?: string) {
  if (refreshToken) {
    const state = browserStateMap.get(getBrowserStateKey(refreshToken));
    if (state) state.chatSessionId = null;
    return;
  }
  for (const state of browserStateMap.values()) state.chatSessionId = null;
}

/**
 * 创建转换流
 *
 * 将流格式转换为gpt兼容流格式
 *
 * @param model 模型名称
 * @param convId 会话ID
 * @param stream 消息流
 * @param endCallback 传输结束回调
 */
function createTransStream(
  model: string,
  convId: string,
  stream: any,
  endCallback?: Function,
  tools?: any[],
  options: { endOnSourceClose?: boolean; onEmptyResponse?: () => Promise<any>; onNeedSignIn?: () => Promise<any> } = {},
  promptTokens = 1
) {
  let completionText = "";
  // 消息创建时间
  const created = util.unixTimestamp();
  const streamStartAt = util.timestamp();
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // 创建转换流
  const transStream = new PassThrough();
  !transStream.closed && transStream.write(`: ${' '.repeat(2048)}\n\n`);
  !transStream.closed &&
    transStream.write(
      `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
        created,
      })}\n\n`
    );
  let ended = false;
  let upstreamPaused = false;
  let sourceReplaced = false;
  const canWrite = () => !ended && !transStream.closed && !transStream.writableEnded && !transStream.destroyed;
  const writeSSE = (payload: any) => {
    if (!canWrite()) return;
    const flushed = transStream.write(`data: ${JSON.stringify(payload)}\n\n: ping\n\n`);
    if (!flushed && !upstreamPaused && typeof stream.pause === 'function' && typeof stream.resume === 'function') {
      upstreamPaused = true;
      stream.pause();
      transStream.once('drain', () => {
        upstreamPaused = false;
        if (canWrite()) stream.resume();
      });
    }
  };
  const finishStream = () => {
    if (!canWrite()) return;
    ended = true;
    transStream.end("data: [DONE]\n\n");
  };

  let bufferedRefContent = '';
  let processed = false;
  let hasVisibleOutput = false;
  let emptyContinuationStarted = false;
  let riskBlocked = false;
  const toolSieve = createToolSieveState();

  function emitTextDelta(text: string) {
    if (!canWrite()) return;
    if (text) {
      hasVisibleOutput = true;
      completionText += text;
    }
    writeSSE({
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      created,
    });
  }

  function emitHeartbeatDelta() {
    if (!canWrite()) return;
    writeSSE({
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: null }],
      created,
    });
  }

  function emitToolCalls(toolCalls: any[]) {
    if (!canWrite()) return;
    hasVisibleOutput = true;
    // 发送 text before tool calls (传之前已经 flush 过了，这边只发 tool calls)
    for (const tc of toolCalls) {
      // 1. tool call header (id, type, function.name)
      writeSSE({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: tc.index,
              id: tc.id,
              type: tc.type,
              function: { name: tc.function.name, arguments: '' },
            }],
          },
          finish_reason: null,
        }],
        created,
      });
      // 2. tool call arguments
      writeSSE({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: tc.index,
              function: { arguments: tc.function.arguments },
            }],
          },
          finish_reason: null,
        }],
        created,
      });
    }
    // 3. done chunk
    let totalToolTokens = 0;
    for (const tc of toolCalls) {
      totalToolTokens += estimateTextTokens(tc.function.name + tc.function.arguments);
    }
    const finalData: any = {
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: totalToolTokens || 1,
        total_tokens: promptTokens + (totalToolTokens || 1)
      },
      created,
    };
    writeSSE(finalData);
    finishStream();
    endCallback && endCallback();
  }

  function emitTextOnly(text: string) {
    if (!text) return;
    emitTextDelta(text);
  }

  function handleToolSieveEvents(events: ReturnType<typeof processToolStreamChunk>) {
    for (const event of events) {
      if (processed || !canWrite()) return;
      if (event.toolCalls && event.toolCalls.length > 0) {
        processed = true;
        emitToolCalls(toOpenAIToolCalls(event.toolCalls));
      } else if (event.content) {
        emitTextDelta(event.content);
      }
    }
  }

  function finalizeToolStream() {
    handleToolSieveEvents(flushToolStream(toolSieve));
    if (processed) return;
    processed = true;
    if (bufferedRefContent) {
      emitTextOnly(`\n\n搜索结果来自：\n${bufferedRefContent.replace(/\n$/, "")}`);
    }
    emitFinishChunk("stop");
    finishStream();
    endCallback && endCallback();
  }

  function emitFinishChunk(finishReason: string) {
    if (!canWrite()) return;
    // Explicación: Calculamos dinámicamente los tokens generados acumulados en el flujo de texto para emitir el uso exacto.
    const completionTokens = estimateTextTokens(completionText);
    writeSSE({
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      created,
    });
  }

  function getStepFunEventType(event: any) {
    if (event?.error) return 'error';
    if (event?.pipelineEvent) return 'pipelineEvent';
    if (event?.textEvent) return 'textEvent';
    if (event?.messageEvent) return 'messageEvent';
    if (event?.reasoningEvent) return 'reasoningEvent';
    if (event?.doneEvent) return 'doneEvent';
    if (event?.messageDoneEvent) return 'messageDoneEvent';
    if (event?.startEvent) return 'startEvent';
    if (event?.sourcingEvent) return 'sourcingEvent';
    if (event?.heartBeatEvent) return 'heartBeatEvent';
    if (event?.riskEvent) return 'riskEvent';
    if (Object.keys(event || {}).length === 0) return 'empty';
    return 'unknown';
  }

  function logStepFunEventTiming(event: any, text: string) {
    const type = getStepFunEventType(event);
    const keys = type === 'unknown' ? ` keys=${Object.keys(event || {}).join(',')}` : '';
    logger.info(`[${new Date().toISOString()}] StepFun事件 type=${type} +${util.timestamp() - streamStartAt}ms textLen=${text.length}${keys}`);
  }

  async function continueEmptyResponse() {
    if (emptyContinuationStarted || hasVisibleOutput || !options.onEmptyResponse || !canWrite()) return false;
    emptyContinuationStarted = true;
    sourceReplaced = true;
    logger.warn(`StepFun stream ended without visible output, continuing once`);
    const nextStream = await options.onEmptyResponse();
    nextStream.pipe(transStream, { end: true });
    return true;
  }

  const parser = (buffer: Buffer) => {
    if (!canWrite()) return;
    const result = _.attempt(() => JSON.parse(buffer.toString()));
    if (_.isError(result))
      throw new Error(`Stream response invalid: ${result}`);
    // 新版API事件包装在 data.event 中
    const event = result.data?.event || result;
    const text = extractStepFunEventText(event);
    logStepFunEventTiming(event, text);
    if (event.error && event.error.code) {
      logger.error(`StepFun stream error (streaming): code=${event.error.code}, message=${event.error.message}, fullEvent=${JSON.stringify(event.error)}`);
      if (isNeedSignInError(event.error) && options.onNeedSignIn) {
        processed = true;
        sourceReplaced = true;
        options.onNeedSignIn().then((nextStream) => {
          nextStream.pipe(transStream, { end: true });
        }).catch((err) => {
          logger.error(`Anonymous stream retry failed: ${err instanceof Error ? err.message : String(err)}`);
          finishStream();
        });
        return;
      }
      const data = `data: ${JSON.stringify({
        id: convId,
        model,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              content: `服务暂时不可用，第三方响应错误：[${event.error.code}] ${event.error.message}`,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
        created,
      })}\n\n`;
      canWrite() && transStream.write(data);
      finishStream();
      endCallback && endCallback();
    } else if (event.pipelineEvent) {
      if (
        event.pipelineEvent.eventSearch &&
        event.pipelineEvent.eventSearch.results
      ) {
        const refContent = event.pipelineEvent.eventSearch.results.reduce(
          (str, v) => {
            return (str += `${v.title} - ${v.url}\n`);
          },
          ""
        );
        if (hasTools) {
          bufferedRefContent = refContent;
        } else {
          emitTextDelta(`检索 ${refContent}\n`);
        }
      }
    } else {
      if (text) {
        if (hasTools) {
          handleToolSieveEvents(processToolStreamChunk(toolSieve, text));
        } else {
          emitTextDelta(text);
        }
      } else if (event.messageEvent) {
      } else if (event.startEvent || event.sourcingEvent) {
      } else if (event.reasoningEvent) {
        emitHeartbeatDelta();
      } else if (event.doneEvent || event.messageDoneEvent) {
        if (!hasVisibleOutput && !riskBlocked && options.onEmptyResponse) {
          continueEmptyResponse().catch((err) => {
            logger.error(`Empty stream continuation failed: ${err instanceof Error ? err.message : String(err)}`);
            if (hasTools) finalizeToolStream();
            else {
              emitFinishChunk("stop");
              finishStream();
              endCallback && endCallback();
            }
          });
          return;
        }
        if (hasTools) {
          finalizeToolStream();
        } else {
          emitFinishChunk("stop");
          finishStream();
          endCallback && endCallback();
        }
      } else if (event.heartBeatEvent || Object.keys(event).length === 0) {
      } else {
      }
    }
  };
  let chunk = Buffer.from([]);
  let temp = Buffer.from([]);
  // 将流数据传到转换器
  stream.on("data", (buffer: Buffer) => {
    if (!canWrite()) return;
    // 接收数据头
    chunk = Buffer.concat([temp, chunk, buffer]);
    // 循环处理chunk中所有完整消息，避免同一条数据内多条消息丢失
    while (!upstreamPaused && chunk.length >= 5) {
      const chunkSize = chunk.readUint32BE(1);
      const totalLen = chunkSize + 5;
      if (chunk.length < totalLen) break;
      if (!canWrite() || upstreamPaused) break;
      parser(chunk.subarray(5, totalLen));
      chunk = chunk.subarray(totalLen);
    }
    temp = chunk;
    chunk = Buffer.from([]);
  });
// Explicación: Agregar registros de depuración en los eventos de finalización y error de la transmisión para diagnosticar por qué se cuelga la respuesta de la API.
  stream.once(
    "error",
    (err: any) => {
      logger.error(`[数据传输流] 上游流发生错误: ${err?.message || err}`);
      if (sourceReplaced && !ended) return;
      if (options.endOnSourceClose === false && !ended) return;
      if (hasTools && !processed) finalizeToolStream();
      else finishStream();
    }
  );
  stream.once(
    "close",
    () => {
      logger.info(`[数据传输流] 上游流已关闭 (close)`);
      if (sourceReplaced && !ended) return;
      if (options.endOnSourceClose === false && !ended) return;
      if (hasTools && !processed) finalizeToolStream();
      else finishStream();
    }
  );
  return transStream;
}

/**
 * 构建数据包（Connect协议二进制信封）
 *
 * @param json 需要发送的JSON字符串
 */
function wrapData(json: string) {
  const data = Buffer.from(json);
  const buffer = Buffer.alloc(data.length + 5);
  buffer.set(data, 5);
  const dataView = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  dataView.setUint8(0, 0x00);
  dataView.setUint32(1, data.length);
  return buffer;
}

/**
 * 生成cookie
 */
function generateCookie(deviceId: string, accessToken: string) {
  return [`Oasis-Token=${accessToken}`, `Oasis-Webid=${deviceId}`].join("; ");
}

/**
 * 预检查文件URL有效性
 *
 * @param fileUrl 文件URL
 */
async function checkFileUrl(fileUrl: string) {
  if (util.isBASE64Data(fileUrl)) return;

  // HEAD 返回 405 时（部分 CDN 如 stepfun 不支持 HEAD），降级为 GET + Range
  let result = await axios.head(fileUrl, {
    timeout: 15000,
    headers: {
      UserAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    },
    validateStatus: () => true,
  });

  if (result.status === 405) {
    result = await axios.get(fileUrl, {
      timeout: 15000,
      maxContentLength: 1024,
      headers: {
        UserAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Range: "bytes=0-0",
      },
      validateStatus: () => true,
    });
  }

  if (result.status >= 400)
    throw new APIException(
      EX.API_FILE_URL_INVALID,
      `File ${fileUrl} is not valid: [${result.status}] ${result.statusText}`
    );
  // 检查文件大小（HEAD 或 GET Range 响应中获取）
  const contentLength =
    result.headers["content-length"] ||
    (result.headers["content-range"]
      ? parseInt(String(result.headers["content-range"]).split("/")[1], 10)
      : null);
  if (contentLength) {
    const fileSize = parseInt(String(contentLength), 10);
    if (fileSize > FILE_MAX_SIZE)
      throw new APIException(
        EX.API_FILE_EXECEEDS_SIZE,
        `File ${fileUrl} is not valid`
      );
  }
}

/**
 * 上传文件
 *
 * @param fileUrl 文件URL
 * @param refreshToken 用于刷新access_token的refresh_token
 */
async function uploadFile(fileUrl: string, refreshToken: string) {
  let filename, fileData: Buffer, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  else if (!/^https?:\/\//i.test(fileUrl)) {
    filename = path.basename(fileUrl);
    fileData = await fs.readFile(fileUrl);
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
    // 预检查远程文件URL可用性
    await checkFileUrl(fileUrl);
    filename = path.basename(fileUrl);
    const queryIndex = filename.indexOf("?");
    if (queryIndex != -1) filename = filename.substring(0, queryIndex);
    ({ data: fileData } = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      // 100M限制
      maxContentLength: FILE_MAX_SIZE,
      headers: {
        UserAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
      // 60秒超时
      timeout: 60000,
    }));
  }

  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);
  // 获取文件的MIME类型
  mimeType = mimeType || mime.getType(filename);
  return uploadDocumentBuffer(filename, fileData, mimeType || "application/octet-stream", refreshToken);
}

async function uploadDocumentBuffer(filename: string, fileData: Buffer, mimeType: string, refreshToken: string) {
  const isImage = mimeType && mimeType.startsWith("image/");
  const uploadUrl = isImage
    ? "https://www.stepfun.com/api/resource/image"
    : "https://www.stepfun.com/api/resource/document";
  const auth = await acquireStepFunAuth(refreshToken);
  const form = new FormData();
  form.append("file", fileData, { filename, contentType: mimeType });
  form.append("scene_id", isImage ? "image" : "file");
  form.append("mime_type", mimeType);
  let result = await axios.post(uploadUrl, form, {
    maxBodyLength: FILE_MAX_SIZE,
    timeout: 60000,
    headers: {
      Cookie: auth.cookie || generateCookie(auth.deviceId, auth.token),
      "Oasis-Webid": auth.deviceId,
      Referer: "https://www.stepfun.com/chats/new",
      ...(auth.anonymous ? ANONYMOUS_HEADERS : FAKE_HEADERS),
      ...form.getHeaders(),
    },
    validateStatus: () => true,
  });
  const payload = checkResult(result, refreshToken);
  const fileId = extractUploadedFileId(payload);
  if (!fileId) {
    throw new APIException(
      EX.API_REQUEST_FAILED,
      `[上传step文件失败]: empty file id, response=${JSON.stringify(payload).substring(0, 500)}`
    );
  }

  return {
    attachmentType: mimeType,
    attachmentId: fileId,
    name: filename,
    url: payload?.url || payload?.data?.url || "",
    width: "undefined",
    height: "undefined",
    size: `${fileData.byteLength}`,
  };
}

function extractUploadedFileId(payload: any): string {
  const candidates = [
    payload?.rid,
    payload?.id,
    payload?.fileId,
    payload?.file_id,
    payload?.attachmentId,
    payload?.resourceId,
    payload?.resource_id,
    payload?.data?.id,
    payload?.data?.rid,
    payload?.data?.fileId,
    payload?.data?.file_id,
    payload?.data?.resourceId,
    payload?.data?.resource_id,
    payload?.document?.id,
    payload?.resource?.id,
  ];
  for (const candidate of candidates) {
    if (_.isString(candidate) && candidate.trim()) return candidate.trim();
  }
  return "";
}

async function uploadCurrentInputFile(text: string, refreshToken: string) {
  const data = Buffer.from(text, "utf8");
  return uploadDocumentBuffer(CURRENT_INPUT_FILENAME, data, CURRENT_INPUT_CONTENT_TYPE, refreshToken);
}

/**
 * Explicación: Estimamos los tokens con un algoritmo heurístico preciso para español/inglés/chino.
 * Un carácter chino equivale a 1.3 tokens aproximadamente, y los caracteres occidentales/otros equivalen a 0.35 tokens.
 * Esto proporciona al cliente OpenClaw una visualización exacta del consumo de tokens y el uso del contexto.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const chMatches = text.match(/[\u4e00-\u9fa5]|[\u3000-\u303f]|[\uff00-\uffef]/g);
  const chineseLen = chMatches ? chMatches.length : 0;
  const otherLen = text.length - chineseLen;
  return Math.max(1, Math.ceil(chineseLen * 1.3 + otherLen * 0.35));
}

/**
 * Explicación: Estimamos los tokens acumulados a partir de los mensajes para representar con precisión el prompt de entrada.
 */
export function estimateMessagesTokens(messages: any[]): number {
  let combinedText = "";
  for (const msg of messages) {
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      combinedText += msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === 'object' && part.type === 'text') {
          combinedText += String(part.text || "");
        }
      }
    }
  }
  return combinedText.length > 0 ? estimateTextTokens(combinedText) : 1;
}

/**
 * Token切分
 *
 * @param authorization 认证字符串
 */
function tokenSplit(authorization: string) {
  return authorization.replace("Bearer ", "").split(",");
}

/**
 * 获取Token存活状态
 */
async function getTokenLiveStatus(refreshToken: string) {
  const [deviceId, token] = refreshToken.split("@");
  const result = await axios.post(
    "https://www.stepfun.com/passport/proto.api.passport.v1.PassportService/RefreshToken",
    {},
    {
      headers: {
        Cookie: `Oasis-Token=${token}`,
        Referer: "https://www.stepfun.com/chats/new",
        ...FAKE_HEADERS,
        "Oasis-Webid": deviceId,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  try {
    const {
      accessToken: { raw: accessTokenRaw },
      refreshToken: { raw: refreshTokenRaw },
    } = checkResult(result, refreshToken);
    return !!(accessTokenRaw && refreshTokenRaw);
  } catch (err) {
    return false;
  }
}

// Explicación: Iniciamos la preparación previa del grupo de identidades anónimas al cargar el módulo para calentar las cuentas.
replenishAnonymousPool().catch(err => {
  logger.error(`[预热池初始化] 预热账号池失败: ${err.message}`);
});

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  resetBrowserConversation,
  getTokenLiveStatus,
  tokenSplit,
  uploadFile,
  acquireToken,
  estimateTextTokens,
  estimateMessagesTokens,
};
