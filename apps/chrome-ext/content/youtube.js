// YouTube extractor — runs in MAIN world to access
// window.ytInitialPlayerResponse, fetches the auto-caption track if
// available, and returns timestamped markdown + a thumbnail base64.

export async function extractYoutube() {
  const player = window.ytInitialPlayerResponse;
  if (!player) {
    return { error: 'ytInitialPlayerResponse missing — page not ready?' };
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
