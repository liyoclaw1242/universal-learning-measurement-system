// ULMS Learn — book session floater (content script).
// Injected into the active tab when a book session is in progress.
// Renders a small fixed-position panel with capture / finish / hide
// controls so the user doesn't have to re-open the popup on every
// page-flip. Survives page navigation because background.js
// re-injects on chrome.tabs.onUpdated.

(function injectFloater() {
  const FLOATER_ID = 'ulms-book-floater';
  if (document.getElementById(FLOATER_ID)) return;

  const SESSION_KEY = 'ulmsBookSession';

  const container = document.createElement('div');
  container.id = FLOATER_ID;
  Object.assign(container.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    width: '260px',
    padding: '12px 14px',
    background: '#0a0e1a',
    color: 'rgba(220, 230, 248, 0.92)',
    border: '1px solid rgba(220, 230, 248, 0.22)',
    borderRadius: '6px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
    fontSize: '12px',
    zIndex: '2147483647',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  });

  const header = document.createElement('div');
  header.style.cssText =
    'display:flex; align-items:center; justify-content:space-between;' +
    'font-family:"JetBrains Mono","SF Mono",Menlo,monospace;' +
    'font-size:9px; letter-spacing:0.18em; text-transform:uppercase;' +
    'color:rgba(220,230,248,0.4);';
  const brand = document.createElement('span');
  brand.textContent = 'ULMS · BOOK';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.title = 'hide (session continues)';
  Object.assign(closeBtn.style, {
    background: 'transparent',
    border: 'none',
    color: 'rgba(220, 230, 248, 0.4)',
    cursor: 'pointer',
    fontSize: '14px',
    padding: '0 4px',
    lineHeight: '1',
  });
  closeBtn.addEventListener('click', () => container.remove());
  header.append(brand, closeBtn);

  const title = document.createElement('div');
  title.style.cssText =
    'font-size:13px; color:rgba(220,230,248,0.92); font-weight:500;' +
    'word-break:break-word; line-height:1.3;';

  const meta = document.createElement('div');
  meta.style.cssText =
    'font-family:"JetBrains Mono","SF Mono",Menlo,monospace; font-size:10px;' +
    'color:rgba(220,230,248,0.62); letter-spacing:0.04em;';

  function makeBtn(label) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      width: '100%',
      padding: '8px',
      fontFamily: '"JetBrains Mono","SF Mono",Menlo,monospace',
      fontSize: '10px',
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      background: 'transparent',
      color: 'rgba(220, 230, 248, 0.92)',
      border: '1px solid rgba(220, 230, 248, 0.22)',
      borderRadius: '4px',
      cursor: 'pointer',
      transition: 'background 0.12s, border-color 0.12s',
    });
    b.addEventListener('mouseover', () => {
      b.style.background = 'rgba(220, 230, 248, 0.06)';
    });
    b.addEventListener('mouseout', () => {
      b.style.background = 'transparent';
    });
    return b;
  }

  const captureBtn = makeBtn('Capture page');
  const finishBtn = makeBtn('Finish & send');
  finishBtn.style.color = 'rgba(220, 230, 248, 0.62)';

  const result = document.createElement('div');
  result.style.cssText =
    'font-family:"JetBrains Mono","SF Mono",Menlo,monospace; font-size:10px;' +
    'color:rgba(220,230,248,0.4); letter-spacing:0.04em;' +
    'min-height:14px; word-break:break-word;';

  container.append(header, title, meta, captureBtn, finishBtn, result);
  document.body.appendChild(container);

  function setResult(msg, kind) {
    result.textContent = msg ?? '';
    if (kind === 'ok') result.style.color = '#82b095';
    else if (kind === 'err') result.style.color = '#b87575';
    else result.style.color = 'rgba(220, 230, 248, 0.4)';
  }

  function render(session) {
    if (!session) {
      container.remove();
      return;
    }
    title.textContent = session.title;
    meta.textContent =
      `${session.pages.length} page${session.pages.length === 1 ? '' : 's'} · ${session.host}`;
  }

  chrome.storage.local.get(SESSION_KEY, (r) => render(r[SESSION_KEY] ?? null));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[SESSION_KEY]) return;
    render(changes[SESSION_KEY].newValue ?? null);
  });

  captureBtn.addEventListener('click', () => {
    setResult('extracting…');
    captureBtn.disabled = true;
    chrome.runtime.sendMessage({ kind: 'floater.add' }, (resp) => {
      captureBtn.disabled = false;
      if (resp?.ok) {
        setResult(`✓ ${resp.pageCount} pages`, 'ok');
      } else {
        setResult(`✗ ${resp?.error ?? 'add failed'}`, 'err');
      }
    });
  });

  finishBtn.addEventListener('click', () => {
    setResult('uploading…');
    finishBtn.disabled = true;
    captureBtn.disabled = true;
    chrome.runtime.sendMessage({ kind: 'floater.finish' }, (resp) => {
      finishBtn.disabled = false;
      captureBtn.disabled = false;
      if (resp?.ok) {
        setResult(`✓ saved as ${resp.type}/${resp.id}`, 'ok');
      } else {
        setResult(`✗ ${resp?.error ?? 'finish failed'}`, 'err');
      }
    });
  });
})();
