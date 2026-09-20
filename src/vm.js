import { JSDOM } from 'jsdom';
import crypto from 'node:crypto';
import { config } from './config.js';

export class VqdHashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VqdHashError';
  }
}

const DDG_CSP = "default-src 'none'; script-src 'unsafe-inline';";

function createNavigatorMock() {
  return {
    userAgent: config.userAgent,
    platform: 'Win32',
    language: 'en-US',
    languages: ['en-US', 'en'],
    cookieEnabled: true,
    onLine: true,
    hardwareConcurrency: 4,
    maxTouchPoints: 0,
    vendor: 'Google Inc.',
    vendorSub: '',
    productSub: '20030107',
    appName: 'Netscape',
    appVersion: config.userAgent,
    product: 'Gecko',
  };
}

// Replays the environment of a real duck.ai page so the challenge probes
// compute the same fingerprints as a legit browser:
//   probe 2 (base 9973): #jsa iframe with sandbox + CSP meta + __DDG_*__ globals -> 9977
//   probe 3 (base 2765): iframe contentWindow.Proxy.get present -> 2766
function emulateDdgPage(window) {
  window.__DDG_BE_VERSION__ = 'serp_20260901_000000_ET-dummy';
  window.__DDG_FE_CHAT_HASH__ = 'fe-chat-hash-dummy';

  if (window.Proxy && !window.Proxy.get) {
    window.Proxy.get = function get() {
      return 'DuckDuckGo Fraud & Abuse';
    };
  }

  const doc = window.document;
  const jsa = doc.createElement('iframe');
  jsa.id = 'jsa';
  jsa.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  doc.body.appendChild(jsa);

  const jsaDoc = jsa.contentDocument;
  if (jsaDoc && jsaDoc.documentElement) {
    const meta = jsaDoc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', DDG_CSP);
    jsaDoc.documentElement.appendChild(meta);
  }

  // each jsdom iframe gets its own intrinsics, so patch Proxy.get lazily
  // on every iframe contentWindow the challenge creates
  const originalCreateElement = doc.createElement.bind(doc);
  doc.createElement = function (tag, ...args) {
    const el = originalCreateElement(tag, ...args);
    if (String(tag).toLowerCase() === 'iframe' && el) {
      const desc =
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'contentWindow') ||
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Object.getPrototypeOf(el)), 'contentWindow');
      if (desc && desc.get) {
        try {
          Object.defineProperty(el, 'contentWindow', {
            get() {
              const cw = desc.get.call(el);
              if (cw && cw.Proxy && !cw.Proxy.get) {
                cw.Proxy.get = function get() {
                  return 'DuckDuckGo Fraud & Abuse';
                };
              }
              return cw;
            },
            configurable: true,
          });
        } catch {
          // ignore
        }
      }
    }
    return el;
  };

  return () => {
    try {
      jsa.remove();
    } catch {
      // ignore
    }
  };
}

function extractResultsWithJsdom(jsCode) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'https://duck.ai',
      referrer: 'https://duck.ai/',
      pretendToBeVisual: true,
      resources: 'usable',
      runScripts: 'outside-only',
    });

    const { window } = dom;
    const navigatorMock = createNavigatorMock();
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const timeout = setTimeout(() => {
      cleanup();
      reject(new VqdHashError('challenge execution timed out (10s)'));
    }, 10000);

    Object.defineProperty(window, 'navigator', {
      value: navigatorMock,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    function cleanup() {
      clearTimeout(timeout);
      try {
        dom.window.close();
      } catch {
        // ignore
      }
      if (prevWindow === undefined) delete globalThis.window;
      else globalThis.window = prevWindow;
      if (prevDocument === undefined) delete globalThis.document;
      else globalThis.document = prevDocument;
      if (prevNavigator === undefined) {
        delete globalThis.navigator;
      } else {
        Object.defineProperty(globalThis, 'navigator', prevNavigator);
      }
    }

    (async () => {
      globalThis.window = window;
      globalThis.document = window.document;
      Object.defineProperty(globalThis, 'navigator', {
        value: navigatorMock,
        writable: true,
        configurable: true,
        enumerable: true,
      });

      const removeDdgPage = emulateDdgPage(window);

      let result;
      try {
        const raw = window.eval(jsCode);
        // the challenge is an async IIFE and may return a Promise
        result = raw && typeof raw.then === 'function' ? await raw : raw;
      } finally {
        removeDdgPage();
      }

      if (!result || typeof result !== 'object') {
        throw new VqdHashError('challenge returned no result object');
      }

      return {
        server_hashes: Array.isArray(result.server_hashes) ? result.server_hashes : [],
        client_hashes: Array.isArray(result.client_hashes) ? result.client_hashes : [],
        signals: result.signals && typeof result.signals === 'object' ? result.signals : {},
        meta: result.meta && typeof result.meta === 'object' ? result.meta : {},
      };
    })()
      .then((results) => {
        cleanup();
        resolve(results);
      })
      .catch((err) => {
        cleanup();
        reject(err instanceof VqdHashError ? err : new VqdHashError(err.message || String(err)));
      });
  });
}

export async function generateVqdHash(challengeBase64) {
  const startedAt = Date.now();
  if (!challengeBase64 || typeof challengeBase64 !== 'string') {
    throw new VqdHashError('empty challenge');
  }

  let jsCode;
  try {
    jsCode = Buffer.from(challengeBase64, 'base64').toString('utf8');
  } catch {
    throw new VqdHashError('challenge is not valid base64');
  }

  const results = await extractResultsWithJsdom(jsCode);

  if (!results.client_hashes.length) {
    throw new VqdHashError('challenge produced no client_hashes');
  }

  if (process.env.DUCKGO_DEBUG) {
    console.error('[duckgo:debug] raw client_hashes:', JSON.stringify(results.client_hashes));
    console.error('[duckgo:debug] raw server_hashes:', JSON.stringify(results.server_hashes));
    console.error('[duckgo:debug] signals:', JSON.stringify(results.signals));
  }

  results.client_hashes = results.client_hashes.map((value) =>
    crypto.createHash('sha256').update(String(value), 'utf8').digest('base64')
  );

  // mirror the frontend solver: it merges origin/stack/duration into meta
  results.meta = {
    ...results.meta,
    origin: 'https://duck.ai',
    stack: 'Error\n    at l (https://duck.ai/dist/duckai-dist/entry.duckai.js:2:28118)\n    at a (https://duck.ai/dist/duckai-dist/entry.duckai.js:2:27450)',
    duration: String(Math.max(1, Date.now() - startedAt)),
  };

  return Buffer.from(JSON.stringify(results), 'utf8').toString('base64');
}
