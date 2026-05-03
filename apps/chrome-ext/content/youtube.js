// YouTube extractor — runs in MAIN world. ytInitialPlayerResponse is
// only set on a hard page load; SPA navigation (clicking through from
// the homepage / a thumbnail) leaves it unset, so we fall back through
// inline <script> scraping, the <ytd-watch-flexy> element, and finally
// a same-URL refetch which always returns the server-rendered HTML.

export async function extractYoutube() {
  const player = await locatePlayerResponse();
  if (!player) {
    return {
      error:
        'could not locate player data — try a hard refresh (Cmd/Ctrl + Shift + R) and click again',
    };
  }
  const details = player.videoDetails || {};
  const videoId = details.videoId;
  if (!videoId) {
    return { error: 'no video id on page' };
  }

  const tracksRoot = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = tracksRoot?.captionTracks ?? [];
  let transcriptMd = '';
  let captionLang = null;

  if (tracks.length > 0) {
    // Prefer English, then user's first audio track language, then any.
    const preferred =
      tracks.find((t) => /^en\b/i.test(t.languageCode || '')) ??
      tracks[0];
    captionLang = preferred.languageCode || null;
    try {
      // Try the URL as-is first, then with each fmt variant. YouTube's
      // signature only covers params listed in `sparams`, and `fmt` is
      // rarely there, so appending it is safe. If all return empty
      // (PO-token gating, expired signature, etc.) fall through to a
      // DOM scrape of the transcript panel.
      const attempts = [
        preferred.baseUrl,
        addParam(preferred.baseUrl, 'fmt', 'json3'),
        addParam(preferred.baseUrl, 'fmt', 'srv1'),
        addParam(preferred.baseUrl, 'fmt', 'srv3'),
      ];
      let last = { status: 0, ct: '', text: '' };
      for (const url of attempts) {
        const res = await fetch(url, { credentials: 'include' });
        const text = await res.text();
        last = { status: res.status, ct: res.headers.get('content-type') ?? '', text };
        if (text.trim().length > 0) break;
      }
      if (last.text.trim()) {
        transcriptMd = parseTranscript(last.text);
      } else {
        const scraped = await scrapeTranscriptDom();
        if (scraped) {
          transcriptMd = scraped;
        } else {
          transcriptMd =
            `# ${details.title}\n\n_Channel: ${details.author || 'unknown'}_\n\n` +
            `_(caption endpoint returned empty — status=${last.status}, ` +
            `content-type=${last.ct || 'n/a'}; transcript panel not available either)_`;
        }
      }
    } catch (e) {
      transcriptMd = `_(failed to fetch captions: ${e.message ?? e})_`;
    }
  } else {
    transcriptMd = '_(no captions available; STT fallback not implemented)_';
  }

  let thumbnailB64 = null;
  try {
    const blob = await fetch(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`).then(
      (r) => (r.ok ? r.blob() : null),
    );
    if (blob) thumbnailB64 = await blobToBase64(blob);
  } catch {
    // ignore — thumbnail is optional
  }

  const duration = parseInt(details.lengthSeconds, 10);

  return {
    type: 'youtube',
    video_id: videoId,
    source_url: `https://www.youtube.com/watch?v=${videoId}`,
    title: details.title || 'Untitled',
    channel: details.author || null,
    duration_s: Number.isFinite(duration) ? duration : null,
    caption_lang: captionLang,
    transcript: transcriptMd,
    thumbnail_b64: thumbnailB64,
  };

  async function locatePlayerResponse() {
    // SPA navigations leave window.ytInitialPlayerResponse holding the
    // PREVIOUS video's data. Cross-check every source against the
    // current URL's ?v= and skip any that mismatch — otherwise a new
    // capture overwrites the prior video's raw/youtube/<id>/ folder.
    const urlId = (() => {
      try {
        return new URL(window.location.href).searchParams.get('v');
      } catch {
        return null;
      }
    })();
    const ok = (p) => {
      const id = p?.videoDetails?.videoId;
      if (!id) return false;
      if (urlId && id !== urlId) return false;
      return true;
    };

    // A: hard-loaded /watch page sets the global directly
    if (ok(window.ytInitialPlayerResponse)) return window.ytInitialPlayerResponse;

    // B: inline <script> tags carry `var ytInitialPlayerResponse = {…};`
    for (const s of document.querySelectorAll('script')) {
      const txt = s.textContent;
      if (!txt || !txt.includes('ytInitialPlayerResponse')) continue;
      const obj = extractObjectAfter(txt, 'ytInitialPlayerResponse');
      if (ok(obj)) return obj;
    }

    // C: SPA-mounted <ytd-watch-flexy> Polymer element exposes playerData
    const flexy = document.querySelector('ytd-watch-flexy');
    const fromElement = flexy?.playerData ?? flexy?.__data?.playerData;
    if (ok(fromElement)) return fromElement;

    // D: refetch the URL — the server-rendered HTML always has the var
    try {
      const res = await fetch(window.location.href, { credentials: 'include' });
      if (res.ok) {
        const html = await res.text();
        const obj = extractObjectAfter(html, 'ytInitialPlayerResponse');
        if (ok(obj)) return obj;
      }
    } catch {
      // ignore — last-resort fallback
    }
    return null;
  }

  // Walk balanced braces from the first `{` after `<name> = ` so we
  // don't try to regex through nested JSON (which always loses).
  function extractObjectAfter(source, name) {
    const re = new RegExp(`(?:var\\s+)?${name}\\s*=\\s*`);
    const m = re.exec(source);
    if (!m) return null;
    const start = source.indexOf('{', m.index + m[0].length);
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let j = start; j < source.length; j++) {
      const ch = source[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, j + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  function addParam(url, key, val) {
    const re = new RegExp(`([?&])${key}=[^&]*`);
    if (re.test(url)) return url.replace(re, `$1${key}=${val}`);
    return `${url}${url.includes('?') ? '&' : '?'}${key}=${val}`;
  }

  // DOM fallback — YouTube exposes a transcript panel (the "Show
  // transcript" button under the description). When open, every line
  // becomes a <ytd-transcript-segment-renderer> with a .segment-
  // timestamp and .segment-text. We try to open the panel by clicking
  // any matching button, then poll briefly for the segments. If the
  // user has the panel open already this returns immediately.
  async function scrapeTranscriptDom() {
    const readSegments = () => {
      const segs = document.querySelectorAll('ytd-transcript-segment-renderer');
      if (!segs.length) return null;
      const lines = [];
      lines.push(`# ${details.title}\n\n_Channel: ${details.author || 'unknown'}_\n`);
      for (const seg of segs) {
        const ts = seg.querySelector('.segment-timestamp')?.textContent?.trim() || '';
        const txt = seg.querySelector('.segment-text')?.textContent?.replace(/\s+/g, ' ').trim();
        if (txt) lines.push(`[${ts}] ${txt}`);
      }
      return lines.length > 1 ? lines.join('\n\n') : null;
    };

    const direct = readSegments();
    if (direct) return direct;

    const buttons = document.querySelectorAll('button, ytd-button-renderer');
    for (const b of buttons) {
      const label = (b.getAttribute?.('aria-label') ?? '').toLowerCase();
      const text = (b.textContent ?? '').toLowerCase();
      if (
        label.includes('transcript') ||
        text.includes('show transcript') ||
        label.includes('文字記錄') ||
        text.includes('文字記錄') ||
        label.includes('字幕記錄') ||
        text.includes('字幕記錄')
      ) {
        try {
          b.click();
        } catch {
          // ignore — try next candidate
        }
        break;
      }
    }

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const got = readSegments();
      if (got) return got;
    }
    return null;
  }

  // Multi-format caption parser. YouTube's caption baseUrl returns
  // one of three shapes depending on video / track:
  //   • JSON3   `{"events":[{"tStartMs":N, "segs":[{"utf8":"…"}]}]}`
  //   • XML srv1 `<transcript><text start="X" dur="Y">…</text>…`
  //   • XML srv3 `<timedtext><body><p t="ms" d="ms"><s>…</s></p>…`
  // We probe srv3 first (current default for auto-captions), then
  // srv1, then JSON3, falling back to a fingerprint when nothing
  // matches so empties are never silent.
  function parseTranscript(raw) {
    const out = [];
    out.push(`# ${details.title}\n\n_Channel: ${details.author || 'unknown'}_\n`);
    const trimmed = (raw || '').trimStart();
    let lines = 0;

    if (trimmed.startsWith('<')) {
      // srv3 <p t="ms" d="ms">…</p>
      const srv3Re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
      let m;
      while ((m = srv3Re.exec(trimmed)) !== null) {
        const tMatch = /\bt="([^"]+)"/.exec(m[1]);
        if (!tMatch) continue;
        const start = parseFloat(tMatch[1]) / 1000;
        const inner = m[2]
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const text = decodeEntities(inner);
        if (text) {
          out.push(`[${formatTs(start)}] ${text}`);
          lines++;
        }
      }

      if (lines === 0) {
        // srv1 <text start="X" dur="Y">…</text>
        const srv1Re = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
        while ((m = srv1Re.exec(trimmed)) !== null) {
          const sMatch = /\bstart="([^"]+)"/.exec(m[1]);
          const start = sMatch ? parseFloat(sMatch[1]) : 0;
          const inner = m[2]
            .replace(/<[^>]+>/g, '')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const text = decodeEntities(inner);
          if (text) {
            out.push(`[${formatTs(start)}] ${text}`);
            lines++;
          }
        }
      }
    } else if (trimmed.startsWith('{')) {
      try {
        const data = JSON.parse(trimmed);
        const events = Array.isArray(data.events) ? data.events : [];
        for (const ev of events) {
          if (!Array.isArray(ev.segs)) continue;
          const startSec = (ev.tStartMs ?? 0) / 1000;
          const text = ev.segs
            .map((s) => s.utf8 ?? '')
            .join('')
            .replace(/\n/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) {
            out.push(`[${formatTs(startSec)}] ${text}`);
            lines++;
          }
        }
      } catch (e) {
        out.push(`_(JSON parse failed: ${e.message ?? e})_`);
      }
    }

    if (lines === 0) {
      const fp = trimmed.slice(0, 200).replace(/`/g, "'");
      out.push(`_(0 caption lines parsed; first 200 chars: \`${fp}\`)_`);
    }
    return out.join('\n\n');
  }

  function formatTs(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function decodeEntities(s) {
    return s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }

  function blobToBase64(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const url = String(r.result || '');
        const i = url.indexOf(',');
        resolve(i < 0 ? null : url.slice(i + 1));
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  }
}
