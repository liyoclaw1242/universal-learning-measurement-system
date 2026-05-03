// ULMS Learn — popup orchestrator. Two modes:
//   single   ↦ one-shot extract + POST /import (article or youtube)
//   book     ↦ accumulate per-page extractions via background SW;
//              user clicks Add page on each flip, Finish to send.
//              Re-using the same book title resumes the existing
//              ~/.ulms-wiki/raw/books/<slug>/ entry instead of
//              creating a new folder.

import { extractArticle } from './content/article.js';
import { extractYoutube } from './content/youtube.js';

const DEFAULT_SERVER = 'http://127.0.0.1:9527';

const els = {
  conn: document.getElementById('conn'),
  pageType: document.getElementById('page-type'),
  pageTitle: document.getElementById('page-title'),
  result: document.getElementById('result'),
  serverUrl: document.getElementById('server-url'),
  token: document.getElementById('token'),
  saveCfg: document.getElementById('save-cfg'),

  // mode tabs
  modeSingle: document.getElementById('mode-single'),
  modeBook: document.getElementById('mode-book'),
  singlePane: document.getElementById('single-pane'),
  bookPane: document.getElementById('book-pane'),

  // single
  send: document.getElementById('send-btn'),

  // book
  bookStatus: document.getElementById('book-status'),
  bookTitle: document.getElementById('book-title'),
  bookTitleRow: document.getElementById('book-title-row'),
  bookStart: document.getElementById('book-start'),
  bookAdd: document.getElementById('book-add'),
  bookFinish: document.getElementById('book-finish'),
  bookCancel: document.getElementById('book-cancel'),
};

let cfg = { server: DEFAULT_SERVER, token: '' };
let pageType = null; // 'youtube' | 'article' | null
let activeTab = null;
let mode = 'single'; // 'single' | 'book'

async function init() {
  cfg = await loadConfig();
  els.serverUrl.value = cfg.server || DEFAULT_SERVER;
  els.token.value = cfg.token || '';

  els.saveCfg.addEventListener('click', async () => {
    cfg = {
      server: els.serverUrl.value.trim() || DEFAULT_SERVER,
      token: els.token.value.trim(),
    };
    await chrome.storage.local.set({ ulmsConfig: cfg });
    await checkConnection();
    setResult('config saved', 'ok');
  });

  els.send.addEventListener('click', () => void onSend());

  // mode tabs
  for (const tab of [els.modeSingle, els.modeBook]) {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  }

  els.bookStart.addEventListener('click', () => void onBookStart());
  els.bookAdd.addEventListener('click', () => void onBookAdd());
  els.bookFinish.addEventListener('click', () => void onBookFinish());
  els.bookCancel.addEventListener('click', () => void onBookCancel());

  await detectActiveTab();
  await checkConnection();
  await refreshBookStatus();
}

async function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get('ulmsConfig', (r) => {
      resolve(r.ulmsConfig ?? { server: DEFAULT_SERVER, token: '' });
    });
  });
}

async function detectActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  activeTab = tab;
  const url = tab.url || '';
  if (/^https:\/\/(www\.)?youtube\.com\/watch/.test(url)) {
    pageType = 'youtube';
  } else if (/^https?:\/\//.test(url)) {
    pageType = 'article';
  } else {
    pageType = null;
  }
  els.pageType.textContent = pageType ?? 'unsupported';
  els.pageType.dataset.type = pageType ?? '';
  els.pageTitle.textContent = tab.title || '(no title)';
  els.pageTitle.classList.toggle('placeholder', !tab.title);
  els.send.disabled = !pageType;
}

async function checkConnection() {
  els.conn.dataset.state = 'unknown';
  els.conn.title = 'checking…';
  try {
    const res = await fetch(`${cfg.server}/health`, { method: 'GET' });
    if (res.ok) {
      const json = await res.json();
      els.conn.dataset.state = 'ok';
      els.conn.title = `connected · v${json.version ?? '?'}`;
    } else {
      els.conn.dataset.state = 'bad';
      els.conn.title = `HTTP ${res.status}`;
    }
  } catch (e) {
    els.conn.dataset.state = 'bad';
    els.conn.title = `unreachable: ${e}`;
  }
}

function setResult(msg, kind) {
  els.result.textContent = msg;
  els.result.className = `result ${kind ?? ''}`.trim();
}

function setMode(next) {
  mode = next;
  for (const tab of [els.modeSingle, els.modeBook]) {
    tab.classList.toggle('active', tab.dataset.mode === next);
  }
  els.singlePane.hidden = next !== 'single';
  els.bookPane.hidden = next !== 'book';
  if (next === 'book' && !els.bookTitle.value && activeTab?.title) {
    els.bookTitle.value = activeTab.title;
  }
}

// ─── single-page send (existing behavior) ────────────────

async function onSend() {
  if (!pageType || !activeTab) return;
  if (!cfg.token) {
    setResult('paste your token in Settings first', 'err');
    return;
  }

  els.send.disabled = true;
  els.send.classList.add('busy');
  setResult('extracting…');

  try {
    let payload;
    if (pageType === 'youtube') {
      payload = await runInTab(activeTab.id, extractYoutube);
    } else {
      payload = await runInTab(activeTab.id, extractArticle);
    }
    if (!payload || payload.error) {
      throw new Error(payload?.error ?? 'extraction returned nothing');
    }

    setResult('uploading…');
    const res = await fetch(`${cfg.server}/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text}`);
    }
    const meta = await res.json();
    setResult(`✓ saved as ${meta.type}/${meta.id}`, 'ok');
  } catch (e) {
    setResult(`✗ ${e.message ?? e}`, 'err');
  } finally {
    els.send.disabled = !pageType;
    els.send.classList.remove('busy');
  }
}

async function runInTab(tabId, fn) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fn,
  });
  return result;
}

// ─── book session (manual + auto) ────────────────────────

async function refreshBookStatus() {
  const r = await sendBg({ kind: 'book.status' });
  const session = r?.session ?? null;
  if (!session) {
    els.bookStatus.classList.remove('active');
    els.bookStatus.textContent = 'no active session';
    els.bookTitleRow.hidden = false;
    els.bookStart.hidden = false;
    els.bookAdd.hidden = true;
    els.bookFinish.hidden = true;
    els.bookCancel.hidden = true;
    return;
  }
  els.bookStatus.classList.add('active');
  els.bookStatus.textContent =
    `"${session.title}" · ${session.pages.length} page${session.pages.length === 1 ? '' : 's'}`;
  els.bookTitleRow.hidden = true;
  els.bookStart.hidden = true;
  els.bookAdd.hidden = false;
  els.bookFinish.hidden = false;
  els.bookCancel.hidden = false;
}

async function onBookStart() {
  if (!activeTab) {
    setResult('no active tab', 'err');
    return;
  }
  const title = els.bookTitle.value.trim();
  if (!title) {
    setResult('book title required', 'err');
    els.bookTitle.focus();
    return;
  }
  setResult('extracting page 1…');
  const r = await sendBg({
    kind: 'book.start',
    tab: { id: activeTab.id, url: activeTab.url },
    title,
  });
  if (!r?.ok) {
    setResult(`✗ ${r?.error ?? 'start failed'}`, 'err');
    return;
  }
  setResult(`✓ "${title}" · 1 page captured`, 'ok');
  await refreshBookStatus();
}

async function onBookAdd() {
  if (!activeTab) return;
  setResult('extracting…');
  const r = await sendBg({ kind: 'book.add', tabId: activeTab.id });
  if (!r?.ok) {
    setResult(`✗ ${r?.error ?? 'add failed'}`, 'err');
    return;
  }
  setResult(`✓ ${r.pageCount} pages captured`, 'ok');
  await refreshBookStatus();
}

async function onBookCancel() {
  if (!confirm('Discard this book session and its captured pages?')) return;
  await sendBg({ kind: 'book.cancel' });
  setResult('session cleared', 'ok');
  await refreshBookStatus();
}

async function onBookFinish() {
  if (!cfg.token) {
    setResult('paste your token in Settings first', 'err');
    return;
  }
  const r = await sendBg({ kind: 'book.finish' });
  if (!r?.ok) {
    setResult(`✗ ${r?.error ?? 'finish failed'}`, 'err');
    return;
  }
  const session = r.session;
  setResult(`uploading ${session.pages.length} pages…`);
  try {
    const body = {
      type: 'book',
      source_url: session.pages[0]?.source_url ?? `https://${session.host}/`,
      title: session.title,
      author: session.author ?? null,
      pages: session.pages.map((p) => ({ source_url: p.source_url, content: p.content })),
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
    const meta = await res.json();
    setResult(`✓ saved as ${meta.type}/${meta.id}`, 'ok');
    await sendBg({ kind: 'book.clear-after-send' });
    await refreshBookStatus();
  } catch (e) {
    setResult(`✗ ${e.message ?? e}`, 'err');
  }
}

function sendBg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp);
      }
    });
  });
}

init();
