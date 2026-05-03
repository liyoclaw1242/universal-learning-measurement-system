// ULMS Learn — service worker.
// Owns the multi-page "book session" state across popup invocations
// and re-injects the page-side floater on every navigation of the
// session's tab. All capture is manual; user clicks Add page on each
// flip and Finish & send when done.

import { extractArticle } from './content/article.js';

const SESSION_KEY = 'ulmsBookSession';
const CONFIG_KEY = 'ulmsConfig';
const DEFAULT_SERVER = 'http://127.0.0.1:9527';

// Session shape persisted in chrome.storage.local:
//   {
//     tabId: number,
//     host: string,
//     started_at: ISO,
//     title: string,            // user-entered at Start; same title
//                                  resumes the existing raw/books/<slug>/
//     author: string | null,
//     pages: [
//       { source_url, content, captured_at }
//     ]
//   }

async function getSession() {
  return new Promise((resolve) => {
    chrome.storage.local.get(SESSION_KEY, (r) => {
      resolve(r[SESSION_KEY] ?? null);
    });
  });
}

async function setSession(s) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SESSION_KEY]: s }, () => resolve());
  });
}

async function clearSession() {
  return new Promise((resolve) => {
    chrome.storage.local.remove(SESSION_KEY, () => resolve());
  });
}

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEY, (r) => {
      resolve(r[CONFIG_KEY] ?? { server: DEFAULT_SERVER, token: '' });
    });
  });
}

async function injectFloater(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['floater.js'],
    });
  } catch (e) {
    // Tab might be on a chrome:// URL or closed — ignore.
    console.warn('[ulms] floater inject failed', e);
  }
}

// Re-inject the floater whenever the session's tab finishes loading
// a new page (covers <a href> navigations, page reloads, and SPA
// pushState routes that trigger onUpdated with status='complete').
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const session = await getSession();
  if (!session || session.tabId !== tabId) return;
  await injectFloater(tabId);
});

async function uploadBookSession(session) {
  const cfg = await getConfig();
  if (!cfg.token) throw new Error('paste token in popup Settings first');
  const body = {
    type: 'book',
    source_url: session.pages[0]?.source_url ?? `https://${session.host}/`,
    title: session.title,
    author: session.author ?? null,
    pages: session.pages.map((p) => ({
      source_url: p.source_url,
      content: p.content,
    })),
  };
  const res = await fetch(`${cfg.server}/import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return await res.json();
}

async function extractFromTab(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractArticle,
    });
    return result ?? null;
  } catch (e) {
    console.warn('[ulms] extractArticle failed', e);
    return null;
  }
}

async function capturePage(tabId) {
  const session = await getSession();
  if (!session || session.tabId !== tabId) {
    return { ok: false, error: 'no active session for this tab' };
  }
  const payload = await extractFromTab(tabId);
  if (!payload || payload.error) {
    return { ok: false, error: payload?.error ?? 'extraction returned nothing' };
  }
  // No dedupe — manual capture is explicit. If the user adds the same
  // page twice by accident they can cancel + retry, or the duplicate
  // can be cleaned up later by editing body.md.
  session.pages.push({
    source_url: payload.source_url,
    content: payload.content,
    captured_at: new Date().toISOString(),
  });
  await setSession(session);
  return { ok: true, pageCount: session.pages.length };
}

// ─── popup ↔ background message protocol ─────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case 'book.start': {
          const tab = msg.tab;
          if (!tab) {
            sendResponse({ ok: false, error: 'no tab' });
            return;
          }
          const title = (msg.title || '').trim();
          if (!title) {
            sendResponse({ ok: false, error: 'title required' });
            return;
          }
          const payload = await extractFromTab(tab.id);
          if (!payload || payload.error) {
            sendResponse({ ok: false, error: payload?.error ?? 'extract failed' });
            return;
          }
          const url = new URL(tab.url);
          const session = {
            tabId: tab.id,
            host: url.host,
            started_at: new Date().toISOString(),
            title,
            author: payload.author ?? null,
            pages: [
              {
                source_url: payload.source_url,
                content: payload.content,
                captured_at: new Date().toISOString(),
              },
            ],
          };
          await setSession(session);
          await injectFloater(tab.id);
          sendResponse({ ok: true, pageCount: 1, title: session.title });
          return;
        }
        case 'book.add': {
          sendResponse(await capturePage(msg.tabId));
          return;
        }
        case 'floater.add': {
          // Floater always operates on the session's recorded tab.
          const s = await getSession();
          if (!s) {
            sendResponse({ ok: false, error: 'no active session' });
            return;
          }
          sendResponse(await capturePage(s.tabId));
          return;
        }
        case 'floater.finish': {
          const s = await getSession();
          if (!s) {
            sendResponse({ ok: false, error: 'no active session' });
            return;
          }
          if (s.pages.length === 0) {
            sendResponse({ ok: false, error: 'session has 0 pages' });
            return;
          }
          try {
            const meta = await uploadBookSession(s);
            await clearSession();
            sendResponse({ ok: true, type: meta.type, id: meta.id });
          } catch (e) {
            sendResponse({ ok: false, error: e?.message ?? String(e) });
          }
          return;
        }
        case 'book.status': {
          sendResponse({ ok: true, session: await getSession() });
          return;
        }
        case 'book.cancel': {
          await clearSession();
          sendResponse({ ok: true });
          return;
        }
        case 'book.finish': {
          const session = await getSession();
          if (!session) {
            sendResponse({ ok: false, error: 'no active session' });
            return;
          }
          if (session.pages.length === 0) {
            sendResponse({ ok: false, error: 'session has 0 pages' });
            return;
          }
          sendResponse({ ok: true, session });
          return;
        }
        case 'book.clear-after-send': {
          await clearSession();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `unknown kind ${msg.kind}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message ?? String(e) });
    }
  })();
  return true; // async sendResponse
});
