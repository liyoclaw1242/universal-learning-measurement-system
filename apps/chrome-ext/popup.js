// ULMS Learn — popup orchestrator. Detects page type, injects the
// matching content extractor via chrome.scripting.executeScript, then
// POSTs the result to the local ULMS HTTP server.

import { extractArticle } from './content/article.js';
import { extractYoutube } from './content/youtube.js';

const DEFAULT_SERVER = 'http://127.0.0.1:9527';

const els = {
  conn: document.getElementById('conn'),
  pageType: document.getElementById('page-type'),
  pageTitle: document.getElementById('page-title'),
  send: document.getElementById('send-btn'),
  result: document.getElementById('result'),
  serverUrl: document.getElementById('server-url'),
  token: document.getElementById('token'),
  saveCfg: document.getElementById('save-cfg'),
};

let cfg = { server: DEFAULT_SERVER, token: '' };
let pageType = null; // 'youtube' | 'article' | null
let activeTab = null;

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

  await detectActiveTab();
  await checkConnection();
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

async function onSend() {
  if (!pageType || !activeTab) return;
  if (!cfg.token) {
    setResult('paste your token in Settings first', 'err');
    return;
  }

  els.send.disabled = true;
  els.send.classList.add('busy');
  setResult(`extracting…`);

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

    setResult(`uploading…`);
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
    world: 'MAIN', // youtube extractor needs window.ytInitialPlayerResponse
    func: fn,
  });
  return result;
}

init();
