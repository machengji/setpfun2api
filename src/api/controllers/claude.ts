import _ from 'lodash';
import { v1 as uuid } from 'uuid';
import { PassThrough } from 'stream';

import chat from '@/api/controllers/chat.ts';
import logger from '@/lib/logger.ts';
import { selectToken } from '@/api/middleware/auth.ts';
import {
  normalizeParsedToolCallsForSchemas,
  parseToolCallsDetailed,
  parseToolCalls as parseToolCallsCore,
  ParsedToolCall
} from '@/api/controllers/toolcall.ts';
import {
  createToolSieveState,
  flushToolStream,
  processToolStreamChunk
} from '@/api/controllers/toolstream.ts';

const CLAUDE_MODEL_MAP: Record<string, string> = {
  'claude-opus-4-7': 'step-v1',
  'claude-opus-4-6': 'step-v1',
  'claude-opus-4-5': 'step-v1',
  'claude-sonnet-4-7': 'step-v1',
  'claude-sonnet-4-6': 'step-v1',
  'claude-sonnet-4-5': 'step-v1',
  'claude-haiku-4-5': 'step-v1',
  'claude-3-5-sonnet-latest': 'step-v1',
  'claude-3-opus-latest': 'step-v1',
};
const DEFAULT_BLOCKED_TOOL_NAMES = new Set(['agent', 'explore']);

function resolveModel(claudeModel: string): string {
  return CLAUDE_MODEL_MAP[claudeModel] || 'step-v1';
}

function filterClaudeTools(tools: any[] | undefined): any[] {
  if (!tools || tools.length === 0) return [];
  if (process.env.STEPFUN_ALLOW_AGENT_TOOLS === '1') return tools;
  return tools.filter((tool) => {
    const name = String(tool?.name || tool?.function?.name || '').trim().toLowerCase();
    return !DEFAULT_BLOCKED_TOOL_NAMES.has(name);
  });
}

// ── DSML Tool Call Formatting (port from ds2api) ────────────────

/**
 * Format a single tool_use into DSML markup for the prompt text.
 * DSML format: <|DSML|tool_calls><|DSML|invoke name="x"><|DSML|parameter name="y"><![CDATA[value]]></|DSML|parameter></|DSML|invoke></|DSML|tool_calls>
 */
function formatDSMLToolCall(name: string, input: Record<string, any>): string {
  const params = Object.entries(input || {})
    .map(([k, v]) => {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      return `    <|DSML|parameter name="${escapeXMLAttr(k)}"><![CDATA[${escapeCDATA(val)}]]></|DSML|parameter>`;
    })
    .join('\n');

  if (!params) {
    return `  <|DSML|invoke name="${escapeXMLAttr(name)}"></|DSML|invoke>`;
  }

  return `  <|DSML|invoke name="${escapeXMLAttr(name)}">\n${params}\n  </|DSML|invoke>`;
}

function formatDSMLToolCalls(toolCalls: Array<{ name: string; input: Record<string, any> }>): string {
  if (!toolCalls || toolCalls.length === 0) return '';
  const blocks = toolCalls.map(tc => formatDSMLToolCall(tc.name, tc.input)).join('\n');
  return `<|DSML|tool_calls>\n${blocks}\n</|DSML|tool_calls>`;
}

interface ClaudeToolCallState {
  nameById: Map<string, string>;
  lastIdByName: Map<string, string>;
  sequence: number;
}

function createClaudeToolCallState(): ClaudeToolCallState {
  return { nameById: new Map(), lastIdByName: new Map(), sequence: 0 };
}

function nextClaudeToolCallId(state: ClaudeToolCallState) {
  state.sequence += 1;
  return `call_claude_${state.sequence}`;
}

function rememberClaudeToolUse(block: any, state: ClaudeToolCallState) {
  const name = String(block?.name || '').trim();
  const id = String(block?.id || block?.tool_use_id || '').trim();
  if (!name || !id) return;
  state.nameById.set(id, name);
  state.lastIdByName.set(name.toLowerCase(), id);
}

function indexClaudeToolHistory(messages: any[], state: ClaudeToolCallState) {
  for (const msg of messages) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use') rememberClaudeToolUse(block, state);
    }
  }
}

function normalizeClaudeToolUseToAssistant(block: any, state: ClaudeToolCallState) {
  const name = String(block?.name || '').trim();
  if (!name) return null;
  const id = String(block?.id || block?.tool_use_id || '').trim() || nextClaudeToolCallId(state);
  rememberClaudeToolUse({ ...block, id, name }, state);
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  return {
    role: 'assistant',
    content: formatDSMLToolCalls([{ name, input }]),
    tool_calls: [{
      id,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(input),
      },
    }],
  };
}

function normalizeClaudeToolResultToToolMessage(block: any, state: ClaudeToolCallState) {
  const name = String(block?.name || '').trim();
  let toolCallId = String(block?.tool_use_id || block?.tool_call_id || '').trim();
  if (!toolCallId && name) toolCallId = state.lastIdByName.get(name.toLowerCase()) || '';
  if (!toolCallId) toolCallId = nextClaudeToolCallId(state);
  const inferredName = name || state.nameById.get(toolCallId) || '';
  if (inferredName) {
    state.nameById.set(toolCallId, inferredName);
    state.lastIdByName.set(inferredName.toLowerCase(), toolCallId);
  }
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name: inferredName || undefined,
    content: extractToolResultText(block),
  };
}

function normalizeClaudeToolResultToUserMessage(block: any, state: ClaudeToolCallState) {
  const toolMessage = normalizeClaudeToolResultToToolMessage(block, state);
  const label = toolMessage.name || toolMessage.tool_call_id || 'tool';
  return {
    role: 'user',
    content: `[Historical completed tool result (${label}); do not repeat this tool call]:\n${toolMessage.content}`,
  };
}

function describeClaudeToolUse(block: any) {
  const name = String(block?.name || '').trim() || 'tool';
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  return `[Historical completed tool call (${name}); do not repeat]:\n${JSON.stringify(input)}`;
}

function escapeXMLAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeCDATA(text: string): string {
  return text.replace(/]]>/g, ']]]]><![CDATA[>');
}

// ── Tool Prompt 构建（参照 ds2api BuildToolCallInstructions）──

function buildToolCallInstructions(toolNames: string[]): string {
  return `TOOL CALL FORMAT — FOLLOW EXACTLY:

<|DSML|tool_calls>
  <|DSML|invoke name="TOOL_NAME_HERE">
    <|DSML|parameter name="PARAMETER_NAME"><![CDATA[PARAMETER_VALUE]]></|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>

RULES:
1) Use the <|DSML|tool_calls> wrapper format.
2) Put one or more <|DSML|invoke> entries under a single <|DSML|tool_calls> root.
3) Put the tool name in the invoke name attribute: <|DSML|invoke name="TOOL_NAME">.
4) All string values must use <![CDATA[...]]>, including code, scripts, paths, prompts, and queries.
4a) CDATA sections must close with ]]>. Never write </![CDATA]> or </![CDATA[.
5) Every top-level argument must be a <|DSML|parameter name="ARG_NAME">...</|DSML|parameter> node.
6) Use only parameter names shown in Available tools. Do not invent fields.
7) Do NOT wrap XML in markdown fences. Do NOT output explanations, role markers, or internal monologue when using tools.
8) If you call a tool, the first non-whitespace characters of your response must be exactly <|DSML|tool_calls>.
9) Never omit the opening <|DSML|tool_calls> tag.
10) If you do not need a tool, answer normally.

WRONG — Do NOT do these:
Wrong 1 — explanation before tool call:
  I will check git status.
  <|DSML|tool_calls>...</|DSML|tool_calls>
Wrong 2 — markdown fences:
  \`\`\`xml
  <|DSML|tool_calls>...</|DSML|tool_calls>
  \`\`\`
Wrong 3 — missing opening wrapper:
  <|DSML|invoke name="TOOL_NAME">...</|DSML|invoke>
  </|DSML|tool_calls>

Remember: The ONLY valid way to use tools is the <|DSML|tool_calls>...</|DSML|tool_calls> block at the end of your response.

CONTINUATION RULES:
- Historical completed tool calls/results are context only. Never repeat them unless the latest user request explicitly asks you to run them again.
- After receiving tool results, continue the original user task using those results.
- If more information is still needed, call only the next necessary tool.
- If enough information is available, answer normally instead of calling another tool.
- Do not call tools just to inspect prior context files or repeat git/status/diff commands already shown in history.`;
}

function buildToolExamples(toolNames: string[]): string {
  const names = [...new Set(toolNames.filter(n => n))];
  const preferred = names.find(name => ['bash', 'powershell'].includes(name.trim().toLowerCase()));
  const orderedNames = preferred ? [preferred, ...names.filter(name => name !== preferred)] : names;
  const parts: string[] = [];

  if (orderedNames.length > 0) {
    const first = orderedNames[0];
    parts.push(`Example A — Single tool:\n${renderToolExampleBlock([first])}`);
  }

  if (orderedNames.length > 1) {
    parts.push(`Example B — Two tools in parallel:\n${renderToolExampleBlock(orderedNames.slice(0, 2))}`);
  }

  return parts.length > 0 ? `CORRECT EXAMPLES:\n\n${parts.join('\n\n')}` : '';
}

function renderToolExampleBlock(names: string[]): string {
  return `<|DSML|tool_calls>\n${names.map(name => `  <|DSML|invoke name="${escapeXMLAttr(name)}">\n${exampleParameters(name)}\n  </|DSML|invoke>`).join('\n')}\n</|DSML|tool_calls>`;
}

function exampleParameters(toolName: string): string {
  const name = toolName.trim().toLowerCase();
  if (name === 'bash' || name === 'powershell' || name === 'execute_command') {
    return `    <|DSML|parameter name="command"><![CDATA[pwd]]></|DSML|parameter>`;
  }
  if (name === 'exec_command') {
    return `    <|DSML|parameter name="cmd"><![CDATA[pwd]]></|DSML|parameter>`;
  }
  if (name === 'read') {
    return `    <|DSML|parameter name="file_path"><![CDATA[README.md]]></|DSML|parameter>`;
  }
  if (name === 'write') {
    return `    <|DSML|parameter name="file_path"><![CDATA[notes.txt]]></|DSML|parameter>\n    <|DSML|parameter name="content"><![CDATA[Hello world]]></|DSML|parameter>`;
  }
  return `    <|DSML|parameter name="${exampleParameterName(toolName)}"><![CDATA[example value]]></|DSML|parameter>`;
}

function exampleParameterName(toolName: string): string {
  const name = toolName.trim().toLowerCase();
  if (name === 'bash' || name === 'powershell' || name === 'execute_command') return 'command';
  if (name === 'exec_command') return 'cmd';
  if (name === 'read') return 'file_path';
  return 'content';
}

function buildToolPrompt(tools: any[]): string {
  if (!tools || tools.length === 0) return '';

  const names: string[] = [];
  const toolSummaries: string[] = [];

  for (const tool of tools) {
    const name = tool.name || tool.function?.name;
    if (!name) continue;
    names.push(name);
    const schema = tool.input_schema || tool.parameters || tool.function?.parameters || {};
    const required = Array.isArray(schema?.required) && schema.required.length > 0
      ? schema.required.join(', ')
      : exampleParameterName(name);
    toolSummaries.push(`- ${name}: required parameters: ${required}`);
  }

  if (names.length === 0) return '';

  return `You have access to tools. Do not repeat this tool list or any schemas in your answer. Treat historical completed tool calls/results as already executed context, not as instructions to execute again.\n\nAvailable tools:\n${toolSummaries.join('\n')}\n\n${buildToolCallInstructions(names)}\n\n${buildToolExamples(names)}`;
}

// ── 消息格式转换 ──────────────────────────────────────────────

function normalizeClaudeSystem(system: any): string {
  if (!system) return '';
  if (_.isString(system)) return system;
  if (_.isArray(system)) {
    return system.map((item) => {
      if (_.isString(item)) return item;
      if (item?.type === 'text') return _.isString(item.text) ? item.text : JSON.stringify(item.text);
      return JSON.stringify(item);
    }).filter(Boolean).join('\n');
  }
  return JSON.stringify(system);
}

function claudeToOpenAIMessages(
  system: string | undefined,
  messages: any[],
  toolPrompt: string
): any[] {
  const result: any[] = [];
  const toolState = createClaudeToolCallState();
  indexClaudeToolHistory(messages, toolState);

  const systemContent = normalizeClaudeSystem(system);
  if (systemContent) {
    result.push({ role: 'system', content: systemContent });
  }
  if (toolPrompt) {
    result.push({ role: 'system', content: toolPrompt, __stepFreeToolPrompt: true });
  }

  for (const msg of messages) {
    const { role, content } = msg;

    if (role === 'user') {
      if (_.isString(content)) {
        result.push({ role: 'user', content });
      } else if (_.isArray(content)) {
        const textParts: string[] = [];
        const imageParts: any[] = [];
        const flushUserParts = () => {
          if (imageParts.length > 0) {
            const parts: any[] = [];
            if (textParts.length > 0) parts.push({ type: 'text', text: textParts.join('\n') });
            parts.push(...imageParts);
            result.push({ role: 'user', content: parts });
          } else if (textParts.length > 0) {
            result.push({ role: 'user', content: textParts.join('\n') });
          }
          textParts.length = 0;
          imageParts.length = 0;
        };

        for (const block of content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            imageParts.push({
              type: 'image_url',
              image_url: {
                url: block.source?.data
                  ? `data:${block.source.media_type};base64,${block.source.data}`
                  : block.source?.url,
              },
            });
          } else if (block.type === 'image_url') {
            imageParts.push(block);
          } else if (block.type === 'tool_result') {
            flushUserParts();
            result.push(normalizeClaudeToolResultToUserMessage(block, toolState));
          } else if (block.type === 'tool_use') {
            textParts.push(JSON.stringify(block));
          }
        }

        flushUserParts();
      }
    } else if (role === 'assistant') {
      if (_.isString(content)) {
        result.push({ role: 'assistant', content });
      } else if (_.isArray(content)) {
        const textParts: string[] = [];

        for (const block of content) {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            if (textParts.length > 0) {
              result.push({ role: 'assistant', content: textParts.join('\n') });
              textParts.length = 0;
            }
            rememberClaudeToolUse(block, toolState);
            result.push({ role: 'assistant', content: describeClaudeToolUse(block) });
          } else {
            textParts.push(JSON.stringify(block));
          }
        }

        if (textParts.length > 0) {
          result.push({ role: 'assistant', content: textParts.join('\n') });
        }
      }
    }
  }

  return result;
}

/** 提取 tool_result 的文本内容 */
function extractToolResultText(block: any): string {
  const content = block.content;
  if (_.isString(content)) return content;
  if (_.isArray(content)) {
    return content
      .map((c: any) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : JSON.stringify(c)))
      .join('\n');
  }
  if (_.isObject(content)) return JSON.stringify(content);
  return String(content || '');
}

// ── 工具调用解析（DSML / Legacy XML / function 格式）─────────

function parseToolCalls(text: string): ParsedToolCall[] {
  return parseToolCallsCore(text);
}

function normalizeToolCalls(toolCalls: ParsedToolCall[], tools: any[] | undefined): ParsedToolCall[] {
  const normalized = normalizeParsedToolCallsForSchemas(toolCalls, tools).map((tc) => ({
    ...tc,
    input: sanitizeToolInput(tc.input || {}),
  }));
  const seen = new Set<string>();
  return normalized.filter((tc) => {
    const key = `${tc.name}\n${JSON.stringify(tc.input || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeToolInput(value: any): any {
  if (typeof value === 'string') return sanitizeToolString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeToolInput(item));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, current] of Object.entries(value)) out[key] = sanitizeToolInput(current);
    return out;
  }
  return value;
}

function sanitizeToolString(value: string): string {
  let text = String(value || '').trim();
  text = text.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '').trim();
  text = text.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>?/i, '').trim();
  text = text.replace(/<\/?\|?DSML\|?parameter[^>]*>/gi, '').trim();
  text = text.replace(/<\/?parameter[^>]*>/gi, '').trim();
  text = text.replace(/<\/?\|?DSML\|?invoke[^>]*>/gi, '').trim();
  text = text.replace(/<\/?invoke[^>]*>/gi, '').trim();
  return text;
}

function stripToolSyntaxForClaudeText(text: string): string {
  const lower = String(text || '').toLowerCase();
  const starts = [
    lower.indexOf('<|dsml|tool_calls'),
    lower.indexOf('<tool_calls'),
    lower.indexOf('<tool_call'),
    lower.indexOf('<|dsml|invoke'),
    lower.indexOf('<invoke'),
    lower.indexOf('<function='),
  ].filter((index) => index >= 0);
  if (starts.length === 0) return text;
  return text.slice(0, Math.min(...starts)).trim();
}

function buildClaudeResponse(
  id: string,
  model: string,
  text: string,
  inputTokens: number,
  outputTokens: number,
  tools?: any[]
) {
  const content: any[] = [];
  let stopReason = 'end_turn';

  // 解析工具调用
  const toolCalls = normalizeToolCalls(parseToolCalls(text), tools);

  if (toolCalls.length > 0) {
    stopReason = 'tool_use';

    // 添加 tool_use 块
    const msgId = `msg_${id.replace(/-/g, '').substring(0, 24)}`;
    toolCalls.forEach((tc, i) => {
      content.push({
        type: 'tool_use',
        id: `toolu_${msgId.substring(4, 16)}_${i}`,
        name: tc.name,
        input: tc.input,
      });
    });
  } else {
    content.push({ type: 'text', text });
  }

  return {
    id: `msg_${id.replace(/-/g, '').substring(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens || 1,
      output_tokens: outputTokens || 1,
    },
  };
}

// ── 主入口 ────────────────────────────────────────────────────

const msgIdGen = () => `msg_${uuid().replace(/-/g, '').substring(0, 24)}`;


/**
 * 非流式 Claude Messages API
 */
export async function createClaudeMessage(
  model: string,
  system: string | undefined,
  messages: any[],
  tools: any[] | undefined,
  authorization: string,
  useSearch: boolean = true
) {
  const token = selectToken(authorization);
  const stepModel = resolveModel(model);
  const activeTools = filterClaudeTools(tools);
  const toolPrompt = buildToolPrompt(activeTools);
  const openaiMessages = claudeToOpenAIMessages(system, messages, toolPrompt);
  logger.info(`Claude -> StepFun: model=${model} -> ${stepModel}, tools=${activeTools.length}/${tools?.length || 0}`);

  const result = await chat.createCompletion(stepModel, openaiMessages, token, useSearch);
  const text = result?.choices?.[0]?.message?.content || '';
  const usage = result?.usage || {};

  return buildClaudeResponse(result?.id || uuid(), model, text, usage.prompt_tokens || 1, usage.completion_tokens || 1, activeTools);
}

/**
 * 流式 Claude Messages API
 * 将 OpenAI SSE 流实时转换为 Claude SSE 事件格式
 * 支持工具调用检测：缓冲完整响应后解析 DSML/XML，按需发出 tool_use 事件
 */
export async function createClaudeMessageStream(
  model: string,
  system: string | undefined,
  messages: any[],
  tools: any[] | undefined,
  authorization: string,
  useSearch: boolean = true
) {
  const token = selectToken(authorization);
  const stepModel = resolveModel(model);
  const activeTools = filterClaudeTools(tools);
  const toolPrompt = buildToolPrompt(activeTools);
  const openaiMessages = claudeToOpenAIMessages(system, messages, toolPrompt);
  logger.info(`Claude Stream -> StepFun: model=${model} -> ${stepModel}, tools=${activeTools.length}/${tools?.length || 0}`);

  const openaiStream = await chat.createCompletionStream(stepModel, openaiMessages, token, useSearch);

  const transStream = new PassThrough();
  const messageId = msgIdGen();

  let hasStarted = false;
  let hasTextBlock = false;
  let completeText = '';
  let rawText = '';
  let processed = false;
  let sawOpenAIDone = false;
  let sawOpenAIFinishReason = false;
  const hasTools = activeTools.length > 0;
  const streamTimeoutMs = Number(process.env.STEPFUN_CLAUDE_STREAM_TIMEOUT_MS || 90000);
  const streamTimer = hasTools && streamTimeoutMs > 0
    ? setTimeout(() => {
        if (!processed && !transStream.closed) {
          processed = true;
          logger.warn(`Claude stream tool buffering timed out after ${streamTimeoutMs}ms`);
          processCompleteText(rawText);
        }
      }, streamTimeoutMs)
    : null;
  const toolSieve = createToolSieveState();

  function startMessage() {
    if (hasStarted) return;
    hasStarted = true;
    if (!transStream.closed) {
      transStream.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`);
    }
  }

  function ensureTextBlock() {
    if (hasTextBlock) return;
    hasTextBlock = true;
    if (!transStream.closed) {
      transStream.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`);
    }
  }

  function emitTextDelta(text: string) {
    if (!transStream.closed) {
      transStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })}\n\n`);
    }
  }

  function finishWithToolCalls(toolCalls: ParsedToolCall[], textBefore: string) {
    if (transStream.closed) return;

    // 如果有文本内容，先发送文本块
    if (textBefore) {
      startMessage();
      ensureTextBlock();
      emitTextDelta(textBefore);
    }

    // 关闭文本块
    if (hasTextBlock) {
      transStream.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);
    } else if (!textBefore) {
      // 没有文本内容时也需要 start
      startMessage();
    }

    // 发送 tool_use 内容块
    const msgId = messageId.replace('msg_', '').substring(0, 12);
    toolCalls.forEach((tc, i) => {
      logger.info(`Claude tool_use: name=${tc.name}, inputKeys=${Object.keys(tc.input || {}).join(',')}`);
      const toolBlockId = `toolu_${msgId}_${i}`;
      transStream.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: i + (hasTextBlock || textBefore ? 1 : 0),
        content_block: {
          type: 'tool_use',
          id: toolBlockId,
          name: tc.name,
          input: {},
        },
      })}\n\n`);
      transStream.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: i + (hasTextBlock || textBefore ? 1 : 0),
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(tc.input || {}),
        },
      })}\n\n`);
      transStream.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: i + (hasTextBlock || textBefore ? 1 : 0),
      })}\n\n`);
    });

    // message_delta
    transStream.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 1 },
    })}\n\n`);

    transStream.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    transStream.end();
  }

  function finishWithText(fullText: string) {
    if (transStream.closed) return;

    // 如果文本已经通过实时流式发出，则不再重复发送
    const textAlreadyStreamed = hasTextBlock;

    if (!textAlreadyStreamed) {
      startMessage();
      if (fullText) {
        ensureTextBlock();
        emitTextDelta(fullText);
      }
    }

    if (hasTextBlock) {
      transStream.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);
    }

    transStream.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: fullText.length || 1 },
    })}\n\n`);

    transStream.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    transStream.end();
  }

  function finishWithPauseTurn() {
    if (transStream.closed) return;
    startMessage();
    transStream.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'pause_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    })}\n\n`);
    transStream.write(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
    transStream.end();
  }

  function finishMalformedToolCallWithPauseTurn(text: string) {
    const visibleText = stripToolSyntaxForClaudeText(text);
    if (visibleText) {
      startMessage();
      ensureTextBlock();
      emitTextDelta(visibleText);
      transStream.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);
    }
    logger.warn('Claude stream contained malformed tool call syntax; returning pause_turn for retry');
    finishWithPauseTurn();
  }

  function processCompleteText(text: string) {
    const parsed = parseToolCallsDetailed(text);
    const toolCalls = normalizeToolCalls(parsed.calls, activeTools);

    if (toolCalls.length > 0) {
      finishWithToolCalls(toolCalls, '');
    } else if (parsed.sawToolCallSyntax) {
      finishMalformedToolCallWithPauseTurn(text);
    } else {
      finishWithText(text);
    }
  }

  function handleToolSieveContent(content: string) {
    if (!content) return;
    if (hasTools) {
      completeText += content;
      return;
    }
    if (!hasStarted) startMessage();
    if (!hasTextBlock) ensureTextBlock();
    emitTextDelta(content);
  }

  function handleToolSieveCalls(toolCalls: ParsedToolCall[]) {
    const normalized = normalizeToolCalls(toolCalls, activeTools);
    processed = true;
    if (streamTimer) clearTimeout(streamTimer);
    if (normalized.length === 0) {
      finishMalformedToolCallWithPauseTurn(rawText);
      return;
    }
    finishWithToolCalls(normalized, '');
  }

  function handleToolSieveEvents(events: ReturnType<typeof processToolStreamChunk>) {
    for (const event of events) {
      if (processed || transStream.closed) return;
      if (event.toolCalls && event.toolCalls.length > 0) handleToolSieveCalls(event.toolCalls);
      else if (event.content) handleToolSieveContent(event.content);
    }
  }

  let sseBuffer = '';

  openaiStream.on('data', (chunk: Buffer) => {
    sseBuffer += chunk.toString();
    const lines = sseBuffer.split('\n');
    sseBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();

      if (data === '[DONE]') {
        sawOpenAIDone = true;
        break;
      }

      try {
        const parsed = JSON.parse(data);
        const content = parsed?.choices?.[0]?.delta?.content || '';
        const finishReason = parsed?.choices?.[0]?.finish_reason;
        if (finishReason) sawOpenAIFinishReason = true;

        if (content) {
          rawText += content;
          if (hasTools) {
            handleToolSieveEvents(processToolStreamChunk(toolSieve, content));
          } else {
            completeText += content;
            if (!hasStarted) startMessage();
            if (!hasTextBlock) ensureTextBlock();
            emitTextDelta(content);
          }
        }

        // 无工具模式：处理 finish_reason
        if (!hasTools && finishReason) {
          // finish_reason 会在 [DONE] 前的最后一个 chunk 里
        }
      } catch { /* skip parse errors */ }
    }
  });

  function finalizeFromOpenAIStream() {
    if (!processed && !transStream.closed) {
      if (streamTimer) clearTimeout(streamTimer);
      if (hasTools) {
        handleToolSieveEvents(flushToolStream(toolSieve));
        if (processed) return;
        processed = true;
        if (!sawOpenAIDone || !sawOpenAIFinishReason) {
          logger.warn('Claude stream ended without explicit stop; returning pause_turn');
          finishWithPauseTurn();
          return;
        }
        processCompleteText(rawText);
      } else {
        processed = true;
        if (!completeText.trim() && (!sawOpenAIDone || !sawOpenAIFinishReason)) {
          logger.warn('Claude text stream ended without explicit stop or content; returning pause_turn');
          finishWithPauseTurn();
          return;
        }
        finishWithText(completeText);
      }
    }
  }

  openaiStream.once('error', finalizeFromOpenAIStream);

  openaiStream.once('close', finalizeFromOpenAIStream);

  return transStream;
}
