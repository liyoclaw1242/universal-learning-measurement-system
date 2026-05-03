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
      const xml = await fetch(preferred.baseUrl).then((r) => r.text());
      transcriptMd = parseCaptionXml(xml);
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
    // A: hard-loaded /watch page sets the global directly
    const direct = window.ytInitialPlayerResponse;
    if (direct?.videoDetails?.videoId) return direct;

    // B: inline <script> tags carry `var ytInitialPlayerResponse = {…};`
    for (const s of document.querySelectorAll('script')) {
      const txt = s.textContent;
      if (!txt || !txt.includes('ytInitialPlayerResponse')) continue;
      const obj = extractObjectAfter(txt, 'ytInitialPlayerResponse');
      if (obj?.videoDetails?.videoId) return obj;
    }

    // C: SPA-mounted <ytd-watch-flexy> Polymer element exposes playerData
    const flexy = document.querySelector('ytd-watch-flexy');
    const fromElement = flexy?.playerData ?? flexy?.__data?.playerData;
    if (fromElement?.videoDetails?.videoId) return fromElement;

    // D: refetch the URL — the server-rendered HTML always has the var
    try {
      const res = await fetch(window.location.href, { credentials: 'include' });
      if (res.ok) {
        const html = await res.text();
        const obj = extractObjectAfter(html, 'ytInitialPlayerResponse');
        if (obj?.videoDetails?.videoId) return obj;
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

  function parseCaptionXml(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');
    const out = [];
    out.push(`# ${details.title}\n\n_Channel: ${details.author || 'unknown'}_\n`);
    for (const node of doc.querySelectorAll('text')) {
      const start = parseFloat(node.getAttribute('start') || '0');
      const text = decodeEntities(node.textContent || '')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        out.push(`[${formatTs(start)}] ${text}`);
      }
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
