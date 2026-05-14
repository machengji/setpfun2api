import { containsOpenToolCall, parseToolCallsDetailed, ParsedToolCall } from '@/api/controllers/toolcall.ts';

export interface ToolStreamEvent {
  content?: string;
  toolCalls?: ParsedToolCall[];
}

export interface ToolSieveState {
  buffering: boolean;
  captured: string;
}

export function createToolSieveState(): ToolSieveState {
  return { buffering: false, captured: '' };
}

export function processToolStreamChunk(state: ToolSieveState, chunk: string): ToolStreamEvent[] {
  if (!chunk) return [];
  if (!state.buffering && !looksLikeToolStart(chunk)) return [{ content: chunk }];

  state.buffering = true;
  state.captured += chunk;

  const consumed = consumeToolCapture(state.captured, false);
  if (!consumed.ready) return [];

  state.buffering = false;
  state.captured = '';
  return expandConsumedEvents(state, consumed);
}

export function flushToolStream(state: ToolSieveState): ToolStreamEvent[] {
  if (!state.captured) return [];
  const captured = state.captured;
  state.buffering = false;
  state.captured = '';
  const consumed = consumeToolCapture(captured, true);
  const events = expandConsumedEvents(state, consumed);
  return events.length ? events : [{ content: captured }];
}

function expandConsumedEvents(state: ToolSieveState, consumed: ConsumedCapture): ToolStreamEvent[] {
  const events: ToolStreamEvent[] = [];
  if (consumed.prefix) events.push({ content: consumed.prefix });
  if (consumed.toolCalls.length > 0) events.push({ toolCalls: consumed.toolCalls });
  if (consumed.suffix) {
    if (looksLikeToolStart(consumed.suffix)) events.push(...processToolStreamChunk(state, consumed.suffix));
    else events.push({ content: consumed.suffix });
  }
  return events;
}

interface ConsumedCapture {
  prefix: string;
  toolCalls: ParsedToolCall[];
  suffix: string;
  ready: boolean;
}

function consumeToolCapture(captured: string, force: boolean): ConsumedCapture {
  const parsed = parseToolCallsDetailed(captured);
  if (parsed.calls.length > 0) {
    let earliestIndex = -1;
    let matchedRaw = '';
    for (const call of parsed.calls) {
      const index = captured.indexOf(call.raw);
      if (index >= 0 && (earliestIndex < 0 || index < earliestIndex)) {
        earliestIndex = index;
        matchedRaw = call.raw;
      }
    }
    if (earliestIndex >= 0) {
      return {
        prefix: trimWrappingFence(captured.slice(0, earliestIndex)),
        toolCalls: parsed.calls,
        suffix: trimWrappingFence(captured.slice(earliestIndex + matchedRaw.length)),
        ready: true,
      };
    }
    return { prefix: '', toolCalls: parsed.calls, suffix: '', ready: true };
  }

  if (!force && (containsOpenToolCall(captured) || maybeIncompleteFunctionCall(captured))) {
    return { prefix: '', toolCalls: [], suffix: '', ready: false };
  }
  if (parsed.sawToolCallSyntax) {
    return { prefix: trimWrappingFence(splitBeforeToolSyntax(captured)), toolCalls: [], suffix: '', ready: true };
  }

  return { prefix: captured, toolCalls: [], suffix: '', ready: true };
}

function looksLikeToolStart(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('<|dsml|tool_calls') || lower.includes('<tool_calls') || lower.includes('<tool_call') || lower.includes('<|dsml|invoke') || lower.includes('<invoke') || lower.includes('<function=');
}

function splitBeforeToolSyntax(text: string): string {
  const lower = text.toLowerCase();
  const starts = [
    lower.indexOf('<|dsml|tool_calls'),
    lower.indexOf('<tool_calls'),
    lower.indexOf('<tool_call'),
    lower.indexOf('<|dsml|invoke'),
    lower.indexOf('<invoke'),
    lower.indexOf('<function='),
  ].filter((index) => index >= 0);
  if (starts.length === 0) return text;
  return text.slice(0, Math.min(...starts));
}

function maybeIncompleteFunctionCall(text: string): boolean {
  const lower = text.toLowerCase();
  const start = lower.lastIndexOf('<function=');
  if (start < 0) return false;
  const after = lower.slice(start);
  return !after.includes('<function=', 1) && !after.includes('</function>') && !after.includes('</tool_call>');
}

function trimWrappingFence(text: string): string {
  return text.replace(/^\s*```(?:xml|json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}
