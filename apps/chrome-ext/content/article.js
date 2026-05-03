// Generic article extractor — runs in MAIN world via
// chrome.scripting.executeScript. Strategy for most pages:
//   1. find the dominant content node (article > main > body fallback)
//   2. drop nav / aside / footer / scripts / known ad / nav containers
//   3. walk children to produce minimal markdown
//   4. return {type, source_url, title, author, content}
//
// Site-specific dispatch happens at the top of extractArticle. Add a
// new branch when a reader is so different from the article-shape
// that the generic walk gives back nothing useful (e.g. iframe-based
// e-book viewers).

export function extractArticle() {
  const host = window.location.host;

  if (host === 'viewer-ebook.books.com.tw') {
    return extractBooksTwReader();
  }

  return extractGenericArticle();

  // ─── 博客來電子書 reader (epub.js, content lives in <iframe>) ────

  function extractBooksTwReader() {
    // Single-page mode is one iframe; double-spread mode is two —
    // walk every visible iframe inside #UiObj-book-container and
    // concatenate their bodies.
    const iframes = document.querySelectorAll('#UiObj-book-container .epub-view iframe');
    if (iframes.length === 0) {
      return { error: 'no epub.js iframe found — page not ready?' };
    }

    const parts = [];
    for (const iframe of iframes) {
      if (iframe.style && iframe.style.visibility === 'hidden') continue;
      let doc = null;
      try {
        doc = iframe.contentDocument;
      } catch {
        // Cross-origin — shouldn't happen for epub.js srcdoc/blob,
        // but guard anyway.
      }
      if (!doc?.body) continue;
      const md = walkToMarkdown(doc.body);
      if (md) parts.push(md);
    }

    if (parts.length === 0) {
      return { error: 'iframe content empty (cross-origin?)' };
    }

    const bookTitle =
      document.querySelector('#UiObj-header-title')?.textContent?.trim() ||
      document.title ||
      '博客來電子書';
    const chapterTitle =
      document.querySelector('#UiObj-footer-title')?.textContent?.trim() ||
      document.querySelector('#UiObj-book-breadcrumb span')?.textContent?.trim() ||
      '';
    const breadcrumbs = document.querySelectorAll('#UiObj-book-breadcrumb span');
    const progress =
      breadcrumbs.length >= 2 ? breadcrumbs[breadcrumbs.length - 1].textContent.trim() : '';

    // Synthesise a unique source_url per page since 博客來's actual
    // URL is constant across page-flips. Chapter + progress is a
    // reasonable per-page key.
    const fragment = [chapterTitle, progress].filter(Boolean).join(' · ');
    const sourceUrl = fragment
      ? `${window.location.href}#${encodeURIComponent(fragment)}`
      : window.location.href;

    const fullTitle = chapterTitle ? `${bookTitle} — ${chapterTitle}` : bookTitle;

    return {
      type: 'article',
      source_url: sourceUrl,
      title: fullTitle,
      author: null,
      content: parts.join('\n\n'),
    };
  }

  // ─── generic article (article / main / body) ────

  function extractGenericArticle() {
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;

    const md = walkToMarkdown(root);

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
        .replace(/\s*[—–|\-]\s*[^—–|\-]+$/, '')
        .trim() || 'Untitled';

    return {
      type: 'article',
      source_url: window.location.href,
      title: cleanTitle,
      author,
      content: md,
    };
  }

  // ─── shared markdown walk (drops chrome, then walks tree) ────

  function walkToMarkdown(root) {
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
    return out
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
  }

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
