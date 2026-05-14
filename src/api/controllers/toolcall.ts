export interface ParsedToolCall {
  name: string;
  input: Record<string, any>;
  raw: string;
}

export interface ToolCallParseResult {
  calls: ParsedToolCall[];
  sawToolCallSyntax: boolean;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  return parseToolCallsDetailed(text).calls;
}

export function parseToolCallsDetailed(text: string): ToolCallParseResult {
  const trimmed = stripFencedCodeBlocks(String(text || '').trim());
  const result: ToolCallParseResult = {
    calls: [],
    sawToolCallSyntax: looksLikeToolCallSyntax(trimmed),
  };
  if (!trimmed) return result;

  const normalized = normalizeDSMLToolCallMarkup(trimmed);
  if (normalized) {
    result.calls.push(...parseXMLToolCalls(normalized));
    if (result.calls.length === 0 && normalized.toLowerCase().includes('<![cdata[')) {
      result.calls.push(...parseXMLToolCalls(sanitizeLooseCDATA(normalized)));
    }
  }

  result.calls.push(...parseFunctionToolCalls(trimmed));
  result.calls = dedupeParsedToolCalls(result.calls);
  if (result.calls.length > 0) result.sawToolCallSyntax = true;
  return result;
}

function dedupeParsedToolCalls(calls: ParsedToolCall[]): ParsedToolCall[] {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = `${call.name}\n${JSON.stringify(call.input || {})}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeParsedToolCallsForSchemas(toolCalls: ParsedToolCall[], tools: any[] | undefined): ParsedToolCall[] {
  if (!tools || tools.length === 0) return toolCalls;
  const toolMap = new Map<string, { name: string; schema: any }>();
  for (const tool of tools) {
    const meta = extractToolMeta(tool);
    if (meta.name) toolMap.set(meta.name.toLowerCase(), meta);
  }
  if (toolMap.size === 0) return toolCalls;

  return toolCalls.map((tc) => {
    const meta = toolMap.get(tc.name.toLowerCase());
    if (!meta) return tc;
    const normalized = normalizeToolValueWithSchema(tc.input || {}, meta.schema || {});
    const inputObj = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? normalized as Record<string, any>
      : tc.input || {};
    const properties = meta.schema?.properties || {};
    const allowedKeys = Object.keys(properties);
    if (allowedKeys.length === 0) return { ...tc, name: meta.name, input: inputObj };
    const input: Record<string, any> = {};
    for (const key of allowedKeys) {
      if (Object.prototype.hasOwnProperty.call(inputObj, key)) input[key] = inputObj[key];
    }
    const repaired = repairCommandToolInput(meta.name, input, inputObj, allowedKeys);
    return { ...tc, name: meta.name, input: repaired };
  }).filter((tc) => toolCallHasRequiredInput(tc, toolMap.get(tc.name.toLowerCase())?.schema));
}

function repairCommandToolInput(name: string, input: Record<string, any>, inputObj: Record<string, any>, allowedKeys: string[]): Record<string, any> {
  const lowerName = name.trim().toLowerCase();
  const commandKey = lowerName === 'exec_command' ? 'cmd' : (allowedKeys.includes('command') ? 'command' : '');
  if (!commandKey || hasMeaningfulValue(input[commandKey])) return input;
  const aliases = commandKey === 'cmd'
    ? ['cmd', 'command', 'content', 'script', 'code', 'input']
    : ['command', 'cmd', 'content', 'script', 'code', 'input'];
  for (const alias of aliases) {
    const value = inputObj[alias];
    if (hasMeaningfulValue(value)) {
      return { ...input, [commandKey]: value };
    }
  }
  const stringValues = Object.values(inputObj).filter((value) => typeof value === 'string' && value.trim());
  if (stringValues.length === 1) return { ...input, [commandKey]: stringValues[0] };
  return input;
}

function toolCallHasRequiredInput(tc: ParsedToolCall, schema: any): boolean {
  const required = Array.isArray(schema?.required) ? schema.required.map((v: any) => String(v)) : [];
  if (required.length === 0) return true;
  return required.every((key: string) => hasMeaningfulValue(tc.input?.[key]));
}

function hasMeaningfulValue(value: any): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function extractToolNames(tools: any[] | undefined): string[] {
  if (!tools) return [];
  return tools.map((tool) => extractToolMeta(tool).name).filter(Boolean);
}

export function containsOpenToolCall(text: string): boolean {
  const lower = String(text || '').toLowerCase();
  const openIndex = Math.max(
    lower.lastIndexOf('<|dsml|tool_calls'),
    lower.lastIndexOf('<tool_calls'),
    lower.lastIndexOf('<tool_call')
  );
  if (openIndex < 0) return false;
  const after = lower.slice(openIndex);
  return !after.includes('</|dsml|tool_calls>') && !after.includes('</tool_calls>') && !after.includes('</tool_call>');
}

function normalizeDSMLToolCallMarkup(text: string): string | null {
  const lower = text.toLowerCase();
  if (!lower.includes('tool_calls') && !lower.includes('tool_call') && !lower.includes('<|dsml|invoke') && !lower.includes('<invoke') && !/<\|dsml\|[a-z0-9_.:-]+/i.test(text)) return null;
  return text
    .replace(/<\/!\[CDATA\]>/gi, ']]>')
    .replace(/<\/!\[CDATA\[/gi, ']]>')
    .replace(/<\|DSML\|(?!tool_calls\b|invoke\b|parameter\b)([A-Za-z0-9_.:-]+)([^>]*)>/gi, '<tool_calls><invoke name="$1"$2>')
    .replace(/<\/\|DSML\|(?!tool_calls\b|invoke\b|parameter\b)([A-Za-z0-9_.:-]+)\s*>/gi, '</invoke>')
    .replace(/<\|DSML\|tool_calls([^>]*)>/gi, '<tool_calls$1>')
    .replace(/<\/\|DSML\|tool_calls\s*>/gi, '</tool_calls>')
    .replace(/<tool_call([^>]*)>/gi, '<tool_calls$1>')
    .replace(/<\/tool_call\s*>/gi, '</tool_calls>')
    .replace(/<\|DSML\|invoke([^>]*)>/gi, '<invoke$1>')
    .replace(/<\/\|DSML\|invoke\s*>/gi, '</invoke>')
    .replace(/<\|DSML\|parameter([^>]*)>/gi, '<parameter$1>')
    .replace(/<\/\|DSML\|parameter\s*>/gi, '</parameter>');
}

function parseXMLToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const wrapperRegex = /<tool_calls[^>]*>([\s\S]*?)<\/tool_calls\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = wrapperRegex.exec(text)) !== null) {
    const rawWrapper = match[0];
    const body = match[1];
    const invokeRegex = /<invoke\s+name\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/invoke\s*>/gi;
    let im: RegExpExecArray | null;
    while ((im = invokeRegex.exec(body)) !== null) {
      const name = im[1].trim();
      if (!name) continue;
      calls.push({ name, input: parseXMLParameters(im[2]), raw: rawWrapper });
    }
  }
  return calls;
}

function parseXMLParameters(xml: string): Record<string, any> {
  const input: Record<string, any> = {};
  const paramRegex = /<parameter\s+name\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/parameter\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(xml)) !== null) {
    const key = match[1].trim();
    if (!key) continue;
    input[key] = parseScalarValue(extractCDATA(match[2].trim()).trim());
  }
  return input;
}

function parseFunctionToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const functionRegex = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)(?=<\/function>|<\/tool_call>|<function=|$)/g;
  let match: RegExpExecArray | null;
  while ((match = functionRegex.exec(text)) !== null) {
    const name = match[1].trim();
    if (!name) continue;
    const input: Record<string, any> = {};
    const paramRegex = /<parameter=([A-Za-z0-9_.:-]+)>\s*([\s\S]*?)(?=<parameter=|<\/function>|<\/tool_call>|<function=|$)/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRegex.exec(match[2])) !== null) {
      const key = pm[1].trim();
      if (!key) continue;
      input[key] = cleanFunctionParameterValue(pm[2]);
    }
    calls.push({ name, input, raw: match[0] });
  }
  return calls;
}

function cleanFunctionParameterValue(text: string): string {
  let value = extractCDATA(String(text || '').trim()).trim();
  value = value.replace(/<\/?parameter[^>]*>/gi, '').trim();
  value = value.replace(/<\/?function[^>]*>/gi, '').trim();
  value = value.replace(/<\/?tool_call[^>]*>/gi, '').trim();
  value = value.replace(/^<!\[CDATA\[/i, '').replace(/\]\]>$/i, '').trim();
  return value;
}

function extractCDATA(text: string): string {
  const normalized = String(text || '').replace(/<\/!\[CDATA\]>/gi, ']]>').replace(/<\/!\[CDATA\[/gi, ']]>');
  const match = /<!\[CDATA\[([\s\S]*?)\]\]>/i.exec(normalized);
  return match ? match[1] : text;
}

function sanitizeLooseCDATA(text: string): string {
  return text
    .replace(/<\/!\[CDATA\]>/gi, ']]>')
    .replace(/<\/!\[CDATA\[/gi, ']]>')
    .replace(/<!\[CDATA\[([\s\S]*?)(?=<\/parameter\s*>)/gi, '<![CDATA[$1]]>');
}

function parseScalarValue(value: string): any {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  try { return JSON.parse(trimmed); } catch { return value; }
}

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/^\s*```(?:xml|json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function looksLikeToolCallSyntax(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('tool_calls') || lower.includes('tool_call') || lower.includes('<function=') || lower.includes('<|dsml|invoke') || lower.includes('<invoke');
}

function extractToolMeta(tool: any) {
  return {
    name: String(tool?.name || tool?.function?.name || '').trim(),
    schema: tool?.parameters || tool?.input_schema || tool?.inputSchema || tool?.schema ||
      tool?.function?.parameters || tool?.function?.input_schema || tool?.function?.inputSchema || tool?.function?.schema || {},
  };
}

function normalizeToolValueWithSchema(value: any, schema: any): any {
  if (value == null || !schema || typeof schema !== 'object') return value;
  if (shouldCoerceSchemaToString(schema)) return typeof value === 'string' ? value : JSON.stringify(value);
  if (looksLikeObjectSchema(schema) && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties || {};
    const additional = schema.additionalProperties;
    const out: Record<string, any> = {};
    for (const [key, current] of Object.entries(value)) {
      const propSchema = properties[key] || additional;
      out[key] = propSchema ? normalizeToolValueWithSchema(current, propSchema) : current;
    }
    return out;
  }
  if (looksLikeArraySchema(schema) && Array.isArray(value)) {
    const items = schema.items;
    if (!items) return value;
    return value.map((item, index) => normalizeToolValueWithSchema(item, Array.isArray(items) ? items[index] : items));
  }
  return value;
}

function shouldCoerceSchemaToString(schema: any): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (typeof schema.const === 'string') return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((v) => typeof v === 'string')) return true;
  const type = schema.type;
  if (typeof type === 'string') return type.trim().toLowerCase() === 'string';
  if (Array.isArray(type)) {
    let hasString = false;
    for (const item of type) {
      const t = String(item).trim().toLowerCase();
      if (t === 'string') hasString = true;
      else if (t !== 'null') return false;
    }
    return hasString;
  }
  return false;
}

function looksLikeObjectSchema(schema: any): boolean {
  return String(schema?.type || '').toLowerCase() === 'object' || !!schema?.properties || schema?.additionalProperties !== undefined;
}

function looksLikeArraySchema(schema: any): boolean {
  return String(schema?.type || '').toLowerCase() === 'array' || schema?.items !== undefined;
}
