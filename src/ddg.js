import crypto from 'node:crypto';
import { config } from './config.js';
import { generateVqdHash, VqdHashError } from './vm.js';

export class UpstreamError extends Error {
  constructor(status, message) {
    super(message || `upstream error ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

const state = {
  hash: null,
  vqd: null,
  solvedAt: 0,
  inflight: null,
  runtimePinned: null,
  runtimeCookie: null,
  feVersion: null,
  feVersionAt: 0,
};

export function setRuntimeHash(hash, cookie) {
  state.runtimePinned = hash && typeof hash === 'string' && hash.trim() ? hash.trim() : null;
  state.runtimeCookie = cookie && typeof cookie === 'string' && cookie.trim() ? cookie.trim() : null;
  state.hash = null;
  state.inflight = null;
}

export function invalidateHash() {
  state.hash = null;
  state.inflight = null;
}

export function tokenStatus() {
  const active = state.runtimePinned || config.pinnedHash || state.hash;
  return {
    mode: state.runtimePinned
      ? 'runtime-pinned'
      : config.pinnedHash
        ? 'env-pinned'
        : state.hash
          ? 'auto'
          : 'uninitialized',
    hash_preview: active ? `${active.slice(0, 16)}... (${active.length} chars)` : null,
    cookie: state.runtimeCookie
      ? `${state.runtimeCookie.slice(0, 40)}... (${state.runtimeCookie.length} chars)`
      : null,
    vqd: state.vqd,
    fe_version: state.feVersion,
    solved_at: state.solvedAt ? new Date(state.solvedAt).toISOString() : null,
  };
}

async function getFeVersion() {
  if (config.feVersion) return config.feVersion;
  if (state.feVersion && Date.now() - state.feVersionAt < 3600000) return state.feVersion;
  try {
    const res = await fetch('https://duck.ai/', {
      headers: { 'User-Agent': config.userAgent },
    });
    const html = await res.text();
    const tag = html.match(/data-version-tag="([^"]*)"/)?.[1];
    const sha = html.match(/data-version-sha="([^"]*)"/)?.[1];
    if (tag) {
      state.feVersion = `${tag}-${sha || 'hash'}`;
      state.feVersionAt = Date.now();
      return state.feVersion;
    }
  } catch {
    // fall through
  }
  return 'dev-hash';
}

function feSignals() {
  const start = Date.now();
  const end = start + Math.floor(Math.random() * 150000) + 60000;
  return Buffer.from(JSON.stringify({ start, events: [], end }), 'utf8').toString('base64');
}

function journeyId() {
  return crypto.randomBytes(16).toString('hex');
}

function browserHeaders(model) {
  return {
    'Accept-Language': 'ru-IN,ru-RU;q=0.9,ru;q=0.8,en-US;q=0.7,en;q=0.6',
    Dnt: '1',
    Priority: 'u=1, i',
    'Sec-Ch-Ua': '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

async function fetchChallenge() {
  const headers = {
    'User-Agent': config.userAgent,
    'x-vqd-accept': '1',
    'Cache-Control': 'no-store',
    Accept: '*/*',
    Origin: 'https://duck.ai',
    Referer: 'https://duck.ai/',
  };
  if (state.runtimeCookie) headers.Cookie = state.runtimeCookie;
  const res = await fetch(`${config.baseUrl}/duckchat/v1/status`, { headers });
  if (!res.ok) {
    throw new UpstreamError(502, `status request failed: ${res.status}`);
  }
  const challenge = res.headers.get('x-vqd-hash-1');
  if (!challenge) {
    throw new UpstreamError(502, 'no x-vqd-hash-1 challenge header in status response');
  }
  state.vqd = res.headers.get('x-vqd-4') || state.vqd;
  return challenge;
}

async function solveHash() {
  const challenge = await fetchChallenge();
  const hash = await generateVqdHash(challenge);
  state.hash = hash;
  state.solvedAt = Date.now();
  return hash;
}

export async function getHash() {
  if (state.runtimePinned) return state.runtimePinned;
  if (config.pinnedHash) return config.pinnedHash;
  if (state.hash) return state.hash;
  if (!state.inflight) {
    state.inflight = solveHash().finally(() => {
      state.inflight = null;
    });
  }
  return state.inflight;
}

async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        yield JSON.parse(payload);
      } catch {
        // skip malformed event
      }
    }
  }
}

export async function* chatStream(model, messages) {
  let attempt = 0;
  const pinned = Boolean(state.runtimePinned || config.pinnedHash);
  const feVersion = await getFeVersion();

  for (;;) {
    const hash = await getHash();

    let res;
    try {
      const headers = {
        'User-Agent': config.userAgent,
        'x-vqd-hash-1': hash,
        'x-fe-version': feVersion,
        'x-fe-signals': feSignals(),
        'x-ddg-journey-id': journeyId(),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Origin: 'https://duck.ai',
        Referer: 'https://duck.ai/',
        ...browserHeaders(model),
      };
      if (state.runtimeCookie) headers.Cookie = state.runtimeCookie;
      res = await fetch(`${config.baseUrl}/duckchat/v1/chat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          metadata: {
            toolChoice: {
              NewsSearch: false,
              VideosSearch: false,
              LocalSearch: false,
              WeatherForecast: false,
            },
          },
          messages,
          canUseTools: true,
          reasoningEffort: 'none',
          canUseApproxLocation: null,
          canDelegateImageGeneration: null,
          canShowGreeting: true,
        }),
      });
    } catch (err) {
      throw new UpstreamError(502, `chat request failed: ${err.message}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const retryable = (res.status === 418 || res.status === 429 || res.status === 400) && attempt < 1;
      if (retryable && !pinned) {
        attempt += 1;
        // the error response may carry a fresh challenge in x-vqd-hash-1 —
        // solve it directly, otherwise re-solve via /status
        const inlineChallenge = res.headers.get('x-vqd-hash-1');
        invalidateHash();
        if (inlineChallenge && !state.inflight) {
          state.inflight = (async () => {
            const solved = await generateVqdHash(inlineChallenge);
            state.hash = solved;
            state.solvedAt = Date.now();
            return solved;
          })().finally(() => {
            state.inflight = null;
          });
        }
        continue;
      }
      throw new UpstreamError(res.status === 418 || res.status === 429 ? 429 : res.status, `upstream ${res.status}: ${text.slice(0, 300)}`);
    }

    yield* parseSse(res.body);
    return;
  }
}
