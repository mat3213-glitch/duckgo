import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { listModels, resolveModel } from './models.js';
import { chatStream, tokenStatus, setRuntimeHash, UpstreamError } from './ddg.js';
import { VqdHashError } from './vm.js';

const MAX_BODY = 10 * 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function openAiError(res, status, message, type = 'api_error', code = null) {
  json(res, status, { error: { message, type, code } });
}

function isAuthorized(req) {
  if (!config.token) return true;
  const auth = req.headers.authorization || '';
  return auth === config.token || auth === `Bearer ${config.token}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function approxTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

function toDuckMessage(m) {
  if (m.role === 'assistant' && typeof m.content === 'string') {
    return { role: m.role, content: m.content };
  }
  return { role: m.role, content: [{ type: 'text', text: m.content }] };
}

function handleChatCompletions(req, res, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return openAiError(res, 400, 'invalid JSON body', 'invalid_request_error');
  }

  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!messages || messages.length === 0) {
    return openAiError(res, 400, 'messages array is required', 'invalid_request_error');
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string') {
      return openAiError(res, 400, 'each message needs role and content', 'invalid_request_error');
    }
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) {
      m.content = m.content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
      continue;
    }
    return openAiError(res, 400, 'message content must be a string or text parts', 'invalid_request_error');
  }

  const duckModel = resolveModel(parsed.model) || config.defaultModel;
  const stream = Boolean(parsed.stream);
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    let content = '';
    (async () => {
      for await (const evt of chatStream(duckModel, messages.map(toDuckMessage))) {
        if (evt.action === 'error') {
          throw new UpstreamError(502, evt.message || 'upstream reported error');
        }
        if (typeof evt.message === 'string') content += evt.message;
      }
      json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: duckModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: approxTokens(messages.map((m) => m.content).join('\n')),
          completion_tokens: approxTokens(content),
          total_tokens: approxTokens(messages.map((m) => m.content).join('\n')) + approxTokens(content),
        },
      });
    })().catch((err) => handleStreamFailure(res, err, id, created, duckModel, content));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model: duckModel,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })}\n\n`);

  (async () => {
    for await (const evt of chatStream(duckModel, messages.map(toDuckMessage))) {
      if (evt.action === 'done') break;
      if (evt.action === 'error') {
        throw new UpstreamError(502, evt.message || 'upstream reported error');
      }
      const text = typeof evt.message === 'string' ? evt.message : '';
      if (text) {
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: duckModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`);
      }
    }
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model: duckModel,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  })().catch((err) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });
}

function handleStreamFailure(res, err, id, created, model, partialContent) {
  if (res.writableEnded) return;
  openAiError(res, err instanceof UpstreamError ? err.status : 502, err.message);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    });
    return res.end();
  }

  if (!isAuthorized(req)) {
    return openAiError(res, 403, 'invalid API key', 'auth_error');
  }

  if (req.method === 'GET' && path === '/') {
    return json(res, 200, {
      service: 'duckgo',
      description: 'Duck.ai to OpenAI-compatible API proxy',
      endpoints: ['GET /v1/models', 'POST /v1/chat/completions', 'GET /token', 'POST /token'],
      token: tokenStatus(),
    });
  }

  if (req.method === 'GET' && path === '/v1/models') {
    return json(res, 200, { object: 'list', data: listModels() });
  }

  if (path === '/token') {
    if (req.method === 'GET') {
      return json(res, 200, tokenStatus());
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return openAiError(res, 400, 'invalid JSON body', 'invalid_request_error');
      }
      const hash = parsed.hash || parsed.token || parsed['x-vqd-hash-1'] || null;
      setRuntimeHash(hash);
      return json(res, 200, { ok: true, token: tokenStatus() });
    }
  }

  if (req.method === 'POST' && path === '/v1/chat/completions') {
    const body = await readBody(req).catch(() => null);
    if (body === null) return openAiError(res, 413, 'payload too large', 'invalid_request_error');
    return handleChatCompletions(req, res, body);
  }

  return openAiError(res, 404, `no route for ${req.method} ${path}`, 'invalid_request_error');
}

export function createServer() {
  return http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      if (err instanceof VqdHashError) {
        return openAiError(res, 502, `session token capture failed: ${err.message}`);
      }
      if (err instanceof UpstreamError) {
        return openAiError(res, err.status, err.message);
      }
      return openAiError(res, 500, err.message || 'internal error');
    });
  });
}
