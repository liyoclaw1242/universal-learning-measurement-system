// RawViewer — right pane of the Wiki tab in "Raw materials" mode.
// Switches body rendering on resource type. Pure presentational.

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ExternalLink, GraduationCap, Trash2 } from 'lucide-react';
import type { RawResourceDetail } from '../../types/home';

interface RawViewerProps {
  detail: RawResourceDetail | null;
  loadError?: string | null;
  hasAnyResource: boolean;
  /** "Go to Learn" stub — host decides what mode/route to push. */
  onGoToLearn: (detail: RawResourceDetail) => void;
  onOpenSource: (url: string) => void;
  onDelete: (type: string, id: string, label: string) => void;
}

export default function RawViewer({
  detail,
  loadError,
  hasAnyResource,
  onGoToLearn,
  onOpenSource,
  onDelete,
}: RawViewerProps) {
  if (loadError) {
    return (
      <section className="wiki-view" aria-label="raw material body">
        <div className="empty">read failed: {loadError}</div>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="wiki-view" aria-label="raw material body">
        <div className="empty">
          {hasAnyResource ? 'Pick a material on the left.' : 'No raw materials yet.'}
        </div>
      </section>
    );
  }

  const { meta, body, thumbnailDataUrl } = detail;

  return (
    <section className="wiki-view" aria-label="raw material body">
      <header className="wiki-view-head">
        <div className="title">
          <h2>{meta.title || meta.id}</h2>
          <span className="badge edited" title={`captured via ${meta.capturedVia}`}>
            {labelForType(meta.type)}
          </span>
        </div>
        <div className="actions">
          {meta.sourceUrl && (
            <button
              type="button"
              className="btn ghost"
              onClick={() => onOpenSource(meta.sourceUrl)}
              title={meta.sourceUrl}
            >
              <ExternalLink size={13} /> Source
            </button>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => onGoToLearn(detail)}
            title="open this material in the Learn workspace"
          >
            <GraduationCap size={13} /> Go to Learn
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => onDelete(meta.type, meta.id, meta.title || meta.id)}
            title="delete folder + meta from ~/.ulms-wiki/raw/"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      <div className="wiki-view-body">
        <div className="raw-meta-row">
          {meta.author && <span>by {meta.author}</span>}
          {meta.channel && <span>· {meta.channel}</span>}
          {typeof meta.durationS === 'number' && (
            <span>· {formatDuration(meta.durationS)}</span>
          )}
          {meta.captionLang && <span>· captions: {meta.captionLang}</span>}
          {typeof meta.pageCount === 'number' && (
            <span>· {meta.pageCount} page{meta.pageCount === 1 ? '' : 's'}</span>
          )}
          {typeof meta.charCount === 'number' && (
            <span>· {meta.charCount.toLocaleString()} chars</span>
          )}
          <span>· captured {meta.capturedAt.slice(0, 10)}</span>
        </div>

        {(meta.type === 'youtube' && thumbnailDataUrl) && (
          <img
            className="raw-cover"
            src={thumbnailDataUrl}
            alt={`${meta.title} cover`}
          />
        )}

        {meta.type === 'image' && thumbnailDataUrl && (
          <img className="raw-image" src={thumbnailDataUrl} alt={meta.title} />
        )}

        {body ? (
          <article className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeKatex]}
            >
              {body}
            </ReactMarkdown>
          </article>
        ) : (
          <div className="empty" style={{ marginTop: 16 }}>
            (no body content — this resource may only carry images / asset files)
          </div>
        )}
      </div>
    </section>
  );
}

function labelForType(t: string): string {
  switch (t) {
    case 'article':
      return 'ARTICLE';
    case 'youtube':
      return 'YOUTUBE';
    case 'paper':
      return 'PAPER';
    case 'image':
      return 'IMAGE';
    case 'markdown':
      return 'MARKDOWN';
    default:
      return t.toUpperCase();
  }
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
