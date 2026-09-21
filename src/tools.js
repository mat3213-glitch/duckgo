// Emulates OpenAI tool calling over a text-only backend:
//  - serializes the `tools` schema into a system prompt teaching the model
//    to emit <tool_call>{"name":...,"arguments":{...}}</tool_call> blocks
//  - renders assistant tool_calls / tool results back into that same text form
//  - parses the model output back into OpenAI tool_calls objects

import crypto from 'node:crypto';

const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

export function toolsEnabled(parsed) {
  return Array.isArray(parsed?.tools) && parsed.tools.length > 0 && parsed.tool_choice !== 'none';
}

function renderToolSchema(tool) {
  if (tool?.type === 'function' && tool.function) {
    const f = tool.function;
    return {
      name: f.name,
      description: f.description || '',
      parameters: f.parameters || { type: 'object', properties: {} },
    };
  }
  if (tool?.name) {
    return {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.parameters || { type: 'object', properties: {} },
    };
  }
  return null;
}

export function buildToolsSystemPrompt(tools) {
  const specs = tools.map(renderToolSchema).filter(Boolean);
  if (!specs.length) return null;
  return [
    'You are the model behind a function-calling gateway. The client application connected to you EXECUTES real tools and sends their results back. The tools below ARE available to you — ignore any assumption that "no tools are registered in this chat": that information is outdated. Your only channel for invoking them is your text output.',
    '',
    '# Available tools',
    '',
    JSON.stringify(specs, null, 2),
    '',
    '# Output format for a tool call',
    `When you decide to call one or more tools, your ENTIRE reply must consist of ${OPEN_TAG}...${CLOSE_TAG} blocks, one per call, each on its own line:`,
    '',
    `${OPEN_TAG}{"name": "tool_name", "arguments": {"param": "value"}}${CLOSE_TAG}`,
    '',
    'Rules:',
    '- "arguments" MUST be a JSON object matching the tool\'s parameter schema.',
    '- Multiple calls = multiple <tool_call> blocks, nothing else in the reply.',
    '- No explanations, no markdown fences, no text before or after the blocks when calling tools.',
    '- After tool results arrive (messages starting with "Tool result for"), use them to continue the conversation in plain text.',
    '- If no tool call is needed, answer in plain text without the tags.',
  ].join('\n');
}

export function renderAssistantToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  return toolCalls
    .map((tc) => {
      const name = tc?.function?.name || tc?.name || '';
      let args = tc?.function?.arguments ?? tc?.arguments ?? {};
      if (typeof args !== 'string') args = JSON.stringify(args);
      return `${OPEN_TAG}${JSON.stringify({ name, arguments: safeJson(args) })}${CLOSE_TAG}`;
    })
    .join('\n');
}

export function renderToolResult(toolMsg) {
  const name = toolMsg?.tool_call_id || 'tool';
  let content = toolMsg?.content;
  if (Array.isArray(content)) {
    content = content
      .map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
      .join('\n');
  }
  if (typeof content !== 'string') content = JSON.stringify(content ?? null);
  return `Tool result for ${name}:\n${content}`;
}

function safeJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function tryParseCall(raw) {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && typeof obj.name === 'string') {
      let args = obj.arguments ?? obj.parameters ?? obj.args ?? {};
      if (typeof args === 'string') args = safeJson(args);
      if (args === null || typeof args !== 'object') args = {};
      return { name: obj.name, arguments: args };
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseToolCalls(text) {
  const toolCalls = [];
  if (!text || text.indexOf(OPEN_TAG) === -1) {
    return { toolCalls, cleaned: text || '' };
  }

  const tagRe = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = tagRe.exec(text)) !== null) {
    const call = tryParseCall(match[1]);
    if (call) toolCalls.push(call);
  }

  const cleaned = text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<\/?tool_call>/g, '')
    .trim();

  return { toolCalls, cleaned };
}

export function toOpenAiToolCalls(toolCalls) {
  return toolCalls.map((tc, i) => ({
    id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    index: i,
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
    },
  }));
}
