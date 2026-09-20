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
  feVersion: null,
  feVersionAt: 0,
};

export function setRuntimeHash(hash) {
  state.runtimePinned = hash && typeof hash === 'string' && hash.trim() ? hash.trim() : null;
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
  return Buffer.from(JSON.stringify({ start: Date.now(), events: [], end: 0 }), 'utf8').toString('base64');
}

async function fetchChallenge() {
  const res = await fetch(`${config.baseUrl}/duckchat/v1/status`, {
    headers: {
      'User-Agent': config.userAgent,
      'x-vqd-accept': '1',
      'Cache-Control': 'no-store',
      Accept: '*/*',
      Origin: 'https://duck.ai',
      Referer: 'https://duck.ai/',
    },
  });
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
      res = await fetch(`${config.baseUrl}/duckchat/v1/chat`, {
        method: 'POST',
        headers: {
          'User-Agent': config.userAgent,
          'x-vqd-hash-1': hash,
          'x-fe-version': feVersion,
          'x-fe-signals': feSignals(),
          'x-ddg-journey-id': crypto.randomUUID(),
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Origin: 'https://duck.ai',
          Referer: 'https://duck.ai/',
        },
        body: JSON.stringify({
          model,
          messages,
          canUseTools: false,
          canUseApproxLocation: false,
          canDelegateImageGeneration: false,
          canUseWebSearch: false,
          canUploadFiles: false,
          canShowGreeting: false,
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
