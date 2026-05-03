// Generic article extractor — runs in MAIN world via
// chrome.scripting.executeScript. Strategy:
//   1. find the dominant content node (article > main > body fallback)
//   2. drop nav / aside / footer / scripts / known ad / nav containers
//   3. walk children to produce minimal markdown:
//      h1-h6 → # ... ###### heading
//      ul / ol → -/1. items
//      blockquote → >
//      pre / code → fenced blocks
//      everything else → paragraph text
//   4. return {type, source_url, title, author, content}

export function extractArticle() {
  const root =
    document.querySelector('article') ||
    document.querySelector('main') ||
    document.querySelector('[role="main"]') ||
    document.body;

  // Work on a shallow clone so we don't mutate the live DOM.
  const clone = root.cloneNode(true);
  const drop = [
    'nav', 'aside', 'footer', 'header', 'form',
    'script', 'style', 'noscript', 'iframe',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[aria-hidden="true"]',
    '.ad', '.advertisement', '.adsbygoogle', '.cookie', '.newsletter',
    '.share', '.social', '.related', '.comments', '.comment-list',
  ];
  for (const sel of drop) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }

  const out = [];
  walk(clone, out);
  const md = out
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');

  const titleMeta =
    document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('meta[name="twitter:title"]')?.content ||
    '';
  const author =
    document.querySelector('meta[name="author"]')?.content ||
    document.querySelector('meta[property="article:author"]')?.content ||
    document.querySelector('[rel="author"]')?.textContent?.trim() ||
    null;

  const cleanTitle =
    (titleMeta || document.title || 'Untitled')
      .replace(/\s*[—–|\-]\s*[^—–|\-]+$/, '') // strip site suffix
      .trim() || 'Untitled';

  return {
    type: 'article',
    source_url: window.location.href,
    title: cleanTitle,
    author,
    content: md,
  };

  function walk(node, sink) {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent.replace(/\s+/g, ' ').trim();
        if (text) sink.push(text);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = child.tagName.toLowerCase();
      switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6': {
          const level = Number(tag.slice(1));
          const text = child.textContent.replace(/\s+/g, ' ').trim();
          if (text) sink.push(`${'#'.repeat(level)} ${text}`);
          break;
        }
        case 'p':
        case 'section': {
          const text = child.textContent.replace(/\s+/g, ' ').trim();
          if (text) sink.push(text);
          break;
        }
        case 'ul':
        case 'ol': {
          const items = [];
          child.querySelectorAll(':scope > li').forEach((li, i) => {
            const t = li.textContent.replace(/\s+/g, ' ').trim();
            if (t) items.push(tag === 'ol' ? `${i + 1}. ${t}` : `- ${t}`);
          });
          if (items.length) sink.push(items.join('\n'));
          break;
        }
        case 'blockquote': {
          const text = child.textContent.replace(/\s+/g, ' ').trim();
          if (text) sink.push(`> ${text}`);
          break;
        }
        case 'pre': {
          const code = child.textContent;
          if (code.trim()) sink.push('```\n' + code.trim() + '\n```');
          break;
        }
        case 'br':
          break;
        case 'div':
        case 'article':
        case 'main':
        default:
          walk(child, sink);
      }
    }
  }
}
