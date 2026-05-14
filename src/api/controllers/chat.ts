import { PassThrough } from "stream";
import path from "path";
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
import APIException from "@/lib/exceptions/APIException.ts";
import EX from "@/api/consts/exceptions.ts";
import logger from "@/lib/logger.ts";
import util from "@/lib/util.ts";

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
// 文件最大大小
const FILE_MAX_SIZE = 100 * 1024 * 1024;
// access_token映射
const accessTokenMap = new Map();
// access_token请求队列映射
const accessTokenRequestQueueMap: Record<string, Function[]> = {};
const browserStateMap = new Map<string, { context: BrowserContext; page: Page | null; chatSessionId: string | null }>();
let browserStreamId = 0;
const CURRENT_INPUT_FILENAME = "DS2API_HISTORY.txt";
const CURRENT_INPUT_CONTENT_TYPE = "text/plain; charset=utf-8";
const CURRENT_INPUT_MIN_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_FILE_MIN_CHARS || 0);
const CURRENT_INPUT_LIVE_MAX_CHARS = Number(process.env.STEPFUN_CURRENT_INPUT_LIVE_MAX_CHARS || 20000);
const CONVERSATION_CREATE_MIN_DELAY_MS = Number(process.env.STEPFUN_CONVERSATION_CREATE_MIN_DELAY_MS || 1000);
const CONVERSATION_CREATE_MAX_DELAY_MS = Number(process.env.STEPFUN_CONVERSATION_CREATE_MAX_DELAY_MS || 3000);
let conversationCreateNextAt = 0;
let conversationCreateThrottleQueue = Promise.resolve();

async function throttleConversationCreate() {
  conversationCreateThrottleQueue = conversationCreateThrottleQueue.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, conversationCreateNextAt - now);
    if (waitMs > 0) {
      logger.info(`Wait ${waitMs}ms before creating StepFun conversation`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    const min = Math.max(0, Math.min(CONVERSATION_CREATE_MIN_DELAY_MS, CONVERSATION_CREATE_MAX_DELAY_MS));
    const max = Math.max(min, Math.max(CONVERSATION_CREATE_MIN_DELAY_MS, CONVERSATION_CREATE_MAX_DELAY_MS));
    const delay = min + Math.floor(Math.random() * (max - min + 1));
    conversationCreateNextAt = Date.now() + delay;
  });
  return conversationCreateThrottleQueue;
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
  logger.info(`Refresh token: ${refreshToken}`);
  const result = await (async () => {
    const [deviceId, token] = refreshToken.split("@");
    const cookie = `Oasis-Token=${token.substring(0, 50)}...${token.substring(token.length - 20)}`;
    logger.info(`[DEBUG] RefreshToken request: deviceId=${deviceId}, cookie=${cookie}`);
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
    logger.info(`Refresh token response status=${result.status}, data=${JSON.stringify(result.data).substring(0, 300)}`);
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
        logger.info(`[DEBUG] accessToken JWT exp=${accessTokenExp}, code TTL=${ACCESS_TOKEN_EXPIRES}s`);
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
      logger.success(`Refresh successful`);
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
async function acquireToken(refreshToken: string) {
  let result = accessTokenMap.get(refreshToken);
  if (!result) {
    logger.info(`[DEBUG] acquireToken: cache miss, fetching fresh token`);
    result = await requestToken(refreshToken);
    accessTokenMap.set(refreshToken, result);
  } else {
    const remaining = result.refreshTime - util.unixTimestamp();
    logger.info(`[DEBUG] acquireToken: cache hit, expires in ${remaining}s, token prefix=${result.accessToken.substring(0, 30)}...`);
    if (util.unixTimestamp() > result.refreshTime) {
      logger.info(`[DEBUG] acquireToken: cache expired, refreshing`);
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
async function createConversation(refreshToken: string) {
  await throttleConversationCreate();
  const { deviceId, token } = await acquireToken(refreshToken);
  const cookieStr = generateCookie(deviceId, token);
  logger.info(`[DEBUG] CreateChatSession request: deviceId=${deviceId}, cookie prefix=${cookieStr.substring(0, 80)}...`);
  const result = await axios.post(
    "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/CreateChatSession",
    {},
    {
      headers: {
        Cookie: generateCookie(deviceId, token),
        "Oasis-Webid": deviceId,
        Referer: "https://www.stepfun.com/chats/new",
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  logger.info(`CreateChatSession response status=${result.status}, data=${JSON.stringify(result.data).substring(0, 500)}`);
  const sessionData = checkResult(result, refreshToken);
  const chatSessionId = sessionData?.chatSession?.chatSessionId;
  if (!chatSessionId) {
    logger.error(`CreateChatSession returned no chatSessionId, full data=${JSON.stringify(result.data).substring(0, 500)}`);
    throw new APIException(EX.API_REQUEST_FAILED, `创建会话失败: StepFun 未返回会话ID`);
  }
  await activateConversationPage(chatSessionId, deviceId, token);
  logger.success(`Created new conversation: ${chatSessionId}`);
  return chatSessionId;
}

async function activateConversationPage(chatSessionId: string, deviceId: string, token: string) {
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
        Cookie: generateCookie(deviceId, token),
        "Oasis-Webid": deviceId,
        "Next-Router-State-Tree": nextRouterStateTree,
        "Next-Url": `/chats/${chatSessionId}`,
        Rsc: "1",
        Referer: `https://www.stepfun.com/chats/${chatSessionId}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    }
  );
  logger.info(`Activate conversation page response status=${result.status}, sessionId=${chatSessionId}`);
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

async function getBrowserPage(refreshToken: string) {
  const stateKey = getBrowserStateKey(refreshToken);
  const state = await getBrowserState(refreshToken);
  const { deviceId, token } = await acquireToken(refreshToken);
  try {
    await state.context.addCookies([
      { name: "Oasis-Token", value: token, domain: "www.stepfun.com", path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
      { name: "Oasis-Webid", value: deviceId, domain: "www.stepfun.com", path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
    ]);
    if (state.page && !state.page.isClosed()) return state.page;
    state.page = state.context.pages()[0] || await state.context.newPage();
    if (!state.page.url().startsWith("https://www.stepfun.com")) {
      await state.page.goto("https://www.stepfun.com/chats/new", { waitUntil: "domcontentloaded" });
    }
    return state.page;
  } catch (err) {
    browserStateMap.delete(stateKey);
    logger.warn(`Browser state for account ${stateKey} is unavailable, recreating: ${err instanceof Error ? err.message : String(err)}`);
  }
  return getBrowserPage(refreshToken);
}

async function createBrowserConversation(refreshToken: string) {
  await throttleConversationCreate();
  const page = await getBrowserPage(refreshToken);
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
  logger.info(`Browser CreateChatSession response status=${sessionData.status}, data=${sessionData.text.substring(0, 500)}`);
  const result = JSON.parse(sessionData.text);
  if (result.code) {
    throw new APIException(EX.API_REQUEST_FAILED, `[浏览器请求step失败]: ${result.message || result.code}`);
  }
  const chatSessionId = result?.chatSession?.chatSessionId;
  if (!chatSessionId) {
    throw new APIException(EX.API_REQUEST_FAILED, `浏览器创建会话失败: StepFun 未返回会话ID`);
  }
  const state = await getBrowserState(refreshToken);
  state.chatSessionId = chatSessionId;
  await activateBrowserConversationPage(refreshToken, chatSessionId);
  return chatSessionId;
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
  logger.info(`Browser activate conversation page response status=${status}, sessionId=${chatSessionId}`);
}

async function createBrowserChatStream(refreshToken: string, chatSessionId: string, body: Buffer) {
  const page = await getBrowserPage(refreshToken);
  const stream = new PassThrough();
  const streamId = `step_stream_${++browserStreamId}`;
  await page.exposeFunction(streamId, (chunk: number[] | null, error?: string) => {
    if (error) {
      stream.destroy(new Error(error));
      return;
    }
    if (!chunk) {
      stream.end();
      return;
    }
    stream.write(Buffer.from(chunk));
  });
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
  }, { streamId, chatSessionId, body: Array.from(body) }).catch((err) => stream.destroy(err));
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

  return `You have access to the following tools. When you need to use a tool, append a DSML tool call block at the end of your response in exactly this format:

<|DSML|tool_calls>
  <|DSML|invoke name="tool_name">
    <|DSML|parameter name="param_name"><![CDATA[value]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

You can call multiple tools in parallel by adding multiple <|DSML|invoke> blocks.
Wrap parameter values in <![CDATA[...]]> to avoid XML escaping issues.
Output ONLY the DSML block at the end of your text response. Do not wrap it in markdown code fences.

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
    logger.info(messages);

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
      const convId = await createBrowserConversation(refreshToken);
      const result = await createBrowserChatStream(refreshToken, convId, messagesPrepare(convId, currentInput.messages, currentInput.refs));
      const streamStartTime = util.timestamp();
      logger.info(`Browser ChatStream started, convId=${convId}`);
      const answer = await receiveStream(model, convId, result);
      logger.success(
        `Browser stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
      return hasTools ? parseToolCallsFromAnswer(answer, tools) : answer;
    }

    const convId = await createConversation(refreshToken);
    const { deviceId, token } = await acquireToken(refreshToken);
    const chatCookie = generateCookie(deviceId, token);
    logger.info(`[DEBUG] ChatStream request: deviceId=${deviceId}, convId=${convId}, cookie prefix=${chatCookie.substring(0, 80)}...`);
    const result = await axios.post(
      "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/ChatStream",
      messagesPrepare(convId, currentInput.messages, currentInput.refs),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: chatCookie,
          "Oasis-Webid": deviceId,
          "Canary": false,
          Referer: `https://www.stepfun.com/chats/${convId}`,
          ...FAKE_HEADERS,
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    logger.info(`ChatStream response status=${result.status}, convId=${convId}`);
    // 接收流为输出文本
    const answer = await receiveStream(model, convId, result.data);
    logger.success(
      `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
    );
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
    logger.info(messages);

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
      const convId = await createBrowserConversation(refreshToken);
      const result = await createBrowserChatStream(refreshToken, convId, messagesPrepare(convId, currentInput.messages, currentInput.refs));
      const streamStartTime = util.timestamp();
      logger.info(`Browser ChatStream started, convId=${convId}`);
      return createTransStream(model, convId, result, () => {
        logger.success(
          `Browser stream has completed transfer ${util.timestamp() - streamStartTime}ms`
        );
      }, tools);
    }
    // 创建会话
    const convId = await createConversation(refreshToken);

    // 请求流
    const { deviceId, token } = await acquireToken(refreshToken);
    const chatCookie = generateCookie(deviceId, token);
    logger.info(`[DEBUG] ChatStream request: deviceId=${deviceId}, convId=${convId}, cookie prefix=${chatCookie.substring(0, 80)}...`);
    const result = await axios.post(
      "https://www.stepfun.com/api/agent/capy.agent.v1.AgentService/ChatStream",
      messagesPrepare(convId, currentInput.messages, currentInput.refs),
      {
        headers: {
          "Content-Type": "application/connect+json",
          Cookie: chatCookie,
          "Oasis-Webid": deviceId,
          "Canary": false,
          Referer: `https://www.stepfun.com/chats/${convId}`,
          ...FAKE_HEADERS,
        },
        // 120秒超时
        timeout: 120000,
        validateStatus: () => true,
        responseType: "stream",
      }
    );

    const streamStartTime = util.timestamp();
    logger.info(`ChatStream response status=${result.status}, convId=${convId} (streaming)`);
    // 创建转换流将消息格式转换为gpt兼容格式
    return createTransStream(model, convId, result.data, () => {
      logger.success(
        `Stream has completed transfer ${util.timestamp() - streamStartTime}ms`
      );
    }, tools);
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
  const urls = [];
  // 如果没有消息，则返回[]
  if (!messages.length) {
    return urls;
  }
  // 只获取最新的消息
  const lastMessage = messages[messages.length - 1];
  if (_.isArray(lastMessage.content)) {
    lastMessage.content.forEach((v) => {
      if (!_.isObject(v) || !["file", "image_url"].includes(v["type"])) return;
      // step-free-api支持格式
      if (
        v["type"] == "file" &&
        _.isObject(v["file_url"]) &&
        _.isString(v["file_url"]["url"])
      )
        urls.push(v["file_url"]["url"]);
      // 兼容gpt-4-vision-preview API格式
      else if (
        v["type"] == "image_url" &&
        _.isObject(v["image_url"]) &&
        _.isString(v["image_url"]["url"])
      )
        urls.push(v["image_url"]["url"]);
    });
  }
  logger.info("本次请求上传：" + urls.length + "个文件");
  return urls;
}

function latestTurnMessages(messages: any[]) {
  if (!messages.length) return messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i]?.role || "user") === "user") {
      return [messages[i]];
    }
  }
  return [messages[messages.length - 1]];
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
function messagesPrepare(chatSessionId: string, messages: any[], refs: any[]) {
  const attachments = refs.map(formatStepFunAttachment).filter(Boolean);
  const content =
    messages.reduce((content, message) => {
      if (_.isArray(message.content)) {
        return message.content.reduce((_content, v) => {
          if (!_.isObject(v) || v["type"] != "text") return _content;
          const text = _.isString(v["text"]) ? v["text"] : JSON.stringify(v["text"]);
          return _content + `${message.role || "user"}:${text || ""}\n`;
        }, content);
      }
      const msgContent = _.isString(message.content) ? message.content : JSON.stringify(message.content);
      return (content += `${message.role || "user"}:${msgContent}\n`);
    }, "") + "assistant:";

  logger.info("\n对话合并：\n" + content);

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
      model: "step-auto",
      enableReasoning: true,
    },
  };

  const bodyJson = JSON.stringify(body);
  logger.info(`ChatStream body (first 500): ${bodyJson.substring(0, 500)}`);
  return encodeConnectJsonEnvelope(bodyJson);
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
  return String(text || "")
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
  const text = sanitizePromptHistoryText(normalizeMessageContentForTranscript(message?.content)).trim();
  return isInternalContinuationPrompt(text) || isInterruptedRequestPlaceholder(text);
}

function clampPromptText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.floor(maxChars / 2))}\n\n[...middle content omitted...]\n\n${text.slice(-Math.floor(maxChars / 2))}`;
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
  const latestUser = findLatestUserMessage(messages);
  const transcript = buildHistoryTranscript(messages, latestUser.index);
  if (!transcript.trim()) return { messages, refs };
  if (transcript.length < CURRENT_INPUT_MIN_CHARS && !hasPromptOverflowArtifacts(messages)) return { messages, refs };
  const toolPromptMessages = messages.filter((message) => message?.__stepFreeToolPrompt);
  const latestUserContent = clampPromptText(latestUser.content, CURRENT_INPUT_LIVE_MAX_CHARS);
  const continuationPrefix = hasTrailingToolResult(messages)
    ? "The latest entries in the context are completed tool results. Use them to continue the original user task. Do not repeat historical tool calls. If more actions are needed, call only the next necessary tool; otherwise answer normally.\n\n"
    : "";
  try {
    const ref = await uploadCurrentInputFile(transcript, refreshToken);
    logger.info(`Current input context (${transcript.length} chars) moved to attached ${CURRENT_INPUT_FILENAME}`);
    const latestUserPrompt = latestUserContent
      ? `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context.\n\nLatest user request:\n${latestUserContent}`
      : `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context and answer the latest user request directly.`;
    return {
      messages: [...toolPromptMessages, {
        role: "user",
        content: latestUserPrompt,
      }],
      refs: [ref, ...refs],
    };
  } catch (err) {
    logger.warn(`Current input context upload failed, falling back to inline context: ${err instanceof Error ? err.message : String(err)}`);
    const inlineTranscript = clampPromptText(transcript, CURRENT_INPUT_LIVE_MAX_CHARS);
    const latestUserPrompt = latestUserContent
      ? `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context.\n\nContext:\n${inlineTranscript}\n\nLatest user request:\n${latestUserContent}`
      : `${continuationPrefix}Use the provided prior context internally. Do not call tools to read context files. Treat historical tool calls/results as already completed and do not repeat them. Continue the task from that context and answer the latest user request directly.\n\nContext:\n${inlineTranscript}`;
    return {
      messages: [...toolPromptMessages, {
        role: "user",
        content: latestUserPrompt,
      }],
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
  if (event?.reasoningEvent?.text) return String(event.reasoningEvent.text);
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
async function receiveStream(model: string, convId: string, stream: any) {
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
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
    stream.once("close", () => resolve(data));
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
  tools?: any[]
) {
  // 消息创建时间
  const created = util.unixTimestamp();
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // 创建转换流
  const transStream = new PassThrough();
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
  const canWrite = () => !ended && !transStream.closed && !transStream.writableEnded && !transStream.destroyed;
  const finishStream = () => {
    if (!canWrite()) return;
    ended = true;
    transStream.end("data: [DONE]\n\n");
  };

  // 工具调用模式：缓冲所有文本，结束时解析
  let bufferedText = '';
  let bufferedRefContent = '';
  let processed = false;

  function emitTextDelta(text: string) {
    if (!canWrite()) return;
    transStream.write(`data: ${JSON.stringify({
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      created,
    })}\n\n`);
  }

  function emitToolCalls(toolCalls: any[]) {
    if (!canWrite()) return;
    // 发送 text before tool calls (传之前已经 flush 过了，这边只发 tool calls)
    for (const tc of toolCalls) {
      // 1. tool call header (id, type, function.name)
      transStream.write(`data: ${JSON.stringify({
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
      })}\n\n`);
      // 2. tool call arguments
      transStream.write(`data: ${JSON.stringify({
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
      })}\n\n`);
    }
    // 3. done chunk
    const finalData: any = {
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created,
    };
    transStream.write(`data: ${JSON.stringify(finalData)}\n\n`);
    finishStream();
    endCallback && endCallback();
  }

  function emitTextOnly(text: string) {
    if (!text) return;
    emitTextDelta(text);
  }

  function processBufferedText() {
    if (processed) return;
    processed = true;
    let fullText = bufferedText;
    if (bufferedRefContent) {
      fullText += `\n\n搜索结果来自：\n${bufferedRefContent.replace(/\n$/, "")}`;
    }

    const parsed = parseToolCallsDetailed(fullText);
    if (parsed.calls.length > 0) {
      logger.info(`Stream tool calls detected: ${parsed.calls.map(c => c.name).join(', ')}`);
      const toolCalls = toOpenAIToolCalls(parsed.calls);
      emitToolCalls(toolCalls);
    } else if (parsed.sawToolCallSyntax) {
      const cleaned = fullText.replace(/<\|?DSML\|?tool_calls[\s\S]*/i, '').replace(/<\|?DSML\|?invoke[\s\S]*/i, '').trim();
      emitTextOnly(cleaned || fullText);
      emitFinishChunk("stop");
      finishStream();
      endCallback && endCallback();
    } else {
      emitTextOnly(fullText);
      emitFinishChunk("stop");
      finishStream();
      endCallback && endCallback();
    }
  }

  function emitFinishChunk(finishReason: string) {
    if (!canWrite()) return;
    transStream.write(`data: ${JSON.stringify({
      id: convId,
      model,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      created,
    })}\n\n`);
  }

  const parser = (buffer: Buffer) => {
    if (!canWrite()) return;
    const result = _.attempt(() => JSON.parse(buffer.toString()));
    if (_.isError(result))
      throw new Error(`Stream response invalid: ${result}`);
    // 新版API事件包装在 data.event 中
    const event = result.data?.event || result;
    if (event.error && event.error.code) {
      logger.error(`StepFun stream error (streaming): code=${event.error.code}, message=${event.error.message}, fullEvent=${JSON.stringify(event.error)}`);
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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
          const data = `data: ${JSON.stringify({
            id: convId,
            model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {
                  content: `检索 ${refContent}\n`,
                },
                finish_reason: null,
              },
            ],
            created,
          })}\n\n`;
          canWrite() && transStream.write(data);
        }
      }
    } else {
      const text = extractStepFunEventText(event);
      if (text) {
        if (hasTools) {
          bufferedText += text;
        } else {
          const data = `data: ${JSON.stringify({
            id: convId,
            model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: { content: text },
                finish_reason: null,
              },
            ],
            created,
          })}\n\n`;
          canWrite() && transStream.write(data);
        }
      } else if (event.messageEvent) {
      } else if (event.startEvent || event.sourcingEvent) {
      } else if (event.doneEvent || event.messageDoneEvent) {
        if (hasTools) {
          processBufferedText();
        } else {
          const data = `data: ${JSON.stringify({
            id: convId,
            model,
            object: "chat.completion.chunk",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            created,
          })}\n\n`;
          canWrite() && transStream.write(data);
          finishStream();
          endCallback && endCallback();
        }
      } else if (event.heartBeatEvent || Object.keys(event).length === 0) {
      } else {
        logger.info(`Unhandled StepFun stream event: ${JSON.stringify(event).substring(0, 500)}`);
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
    while (chunk.length >= 5) {
      const chunkSize = chunk.readUint32BE(1);
      const totalLen = chunkSize + 5;
      if (chunk.length < totalLen) break;
      if (!canWrite()) break;
      parser(chunk.subarray(5, totalLen));
      chunk = chunk.subarray(totalLen);
    }
    temp = chunk;
    chunk = Buffer.from([]);
  });
  stream.once(
    "error",
    () => {
      if (hasTools && !processed) processBufferedText();
      else finishStream();
    }
  );
  stream.once(
    "close",
    () => {
      if (hasTools && !processed) processBufferedText();
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
  // 预检查远程文件URL可用性
  await checkFileUrl(fileUrl);

  let filename, fileData: Buffer, mimeType;
  // 如果是BASE64数据则直接转换为Buffer
  if (util.isBASE64Data(fileUrl)) {
    mimeType = util.extractBASE64DataFormat(fileUrl);
    const ext = mime.getExtension(mimeType);
    filename = `${util.uuid()}.${ext}`;
    fileData = Buffer.from(util.removeBASE64DataHeader(fileUrl), "base64");
  }
  // 下载文件到内存，如果您的服务器内存很小，建议考虑改造为流直传到下一个接口上，避免停留占用内存
  else {
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
  const { deviceId, token } = await acquireToken(refreshToken);
  const form = new FormData();
  form.append("file", fileData, { filename, contentType: mimeType });
  form.append("scene_id", isImage ? "image" : "file");
  form.append("mime_type", mimeType);
  let result = await axios.post(uploadUrl, form, {
    maxBodyLength: FILE_MAX_SIZE,
    timeout: 60000,
    headers: {
      Cookie: generateCookie(deviceId, token),
      "Oasis-Webid": deviceId,
      Referer: "https://www.stepfun.com/chats/new",
      ...FAKE_HEADERS,
      ...form.getHeaders(),
    },
    validateStatus: () => true,
  });
  const payload = checkResult(result, refreshToken);
  logger.info(`Upload document response: ${JSON.stringify(payload).substring(0, 500)}`);
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
  logger.info(`Uploading current input context file: ${CURRENT_INPUT_FILENAME}, chars=${text.length}, bytes=${data.byteLength}`);
  return uploadDocumentBuffer(CURRENT_INPUT_FILENAME, data, CURRENT_INPUT_CONTENT_TYPE, refreshToken);
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

export default {
  createConversation,
  createCompletion,
  createCompletionStream,
  resetBrowserConversation,
  getTokenLiveStatus,
  tokenSplit,
  uploadFile,
  acquireToken,
};
