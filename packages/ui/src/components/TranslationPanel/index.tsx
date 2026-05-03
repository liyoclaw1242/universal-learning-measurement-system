// TranslationPanel — body of the "Learn" tab (right pane).
// Paginated: shows ONLY the translation for `currentPage`, mirroring
// the left-pane PDF nav. Aggregate state (total captures, chars,
// import) lives in the footer.

import { useEffect, useRef } from 'react';
import { Camera, ChevronRight, FileDown, StopCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
// KaTeX stylesheet (math rendering). Imported here so any consumer
// of TranslationPanel gets the formula CSS through the bundler chain.
import 'katex/dist/katex.min.css';

export interface TranslationCapture {
  /** 1-based capture index within the session */
  index: number;
  /** absolute path to the saved PNG */
  imagePath: string;
  /** translation body text (markdown) */
  text: string;
  /** ISO 8601 timestamp string (header) */
  ts: string;
}

interface TranslationPanelProps {
  sourceUrl: string | null;
  /** Page currently displayed in the left pane — drives which capture
   *  is rendered in this panel. */
  currentPage: number;
  totalPages: number;
  streaming: boolean;
  captures: TranslationCapture[];
  imported: boolean;
  onCapture?: () => void;
  onStop?: () => void;
  onImport?: () => void;
  /** Advance the left-pane PDF to the next page. Wired from the
   *  floating CTA at the bottom of the translation body. */
  onNextPage?: () => void;
}

export default function TranslationPanel({
  sourceUrl,
  currentPage,
  totalPages,
  streaming,
  captures,
  imported,
  onCapture,
  onStop,
  onImport,
  onNextPage,
}: TranslationPanelProps) {
  const totalChars = captures.reduce((s, c) => s + c.text.length, 0);
  const translatedCount = captures.filter((c) => c.text.length > 0).length;
  const canImport = translatedCount > 0 && !streaming;
  const current = captures.find((c) => c.index === currentPage);
  const hasText = !!current && current.text.length > 0;

  // Reset scroll to top whenever the page changes so the user reads the
  // new translation from the start.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [currentPage]);

  return (
    <div className="translation-panel">
      <div className="translation-panel-header">
        <span className="url" title={sourceUrl ?? ''}>
          {sourceUrl ?? '(no paper open — open one from the left rail)'}
        </span>
        {streaming && (
          <>
            <span className="status streaming">
              <span className="status-dot" />
              translating
            </span>
            <button
              className="capture-btn"
              onClick={() => onStop?.()}
              style={{
                background: 'var(--ulms-red, #c0392b)',
                borderColor: 'var(--ulms-red, #c0392b)',
              }}
            >
              <StopCircle size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Stop
            </button>
          </>
        )}
        {!streaming && onCapture && (
          <button
            className="capture-btn"
            onClick={() => onCapture()}
            disabled={!sourceUrl}
          >
            <Camera size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Capture
          </button>
        )}
      </div>

      <div className="translation-panel-body" ref={bodyRef}>
        {!sourceUrl ? (
          <div className="empty">Open a paper URL from the left rail to begin.</div>
        ) : hasText ? (
          <section className="capture-section">
            <h3>
              Page {current!.index} · {current!.ts}
            </h3>
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
              >
                {current!.text}
              </ReactMarkdown>
            </div>
          </section>
        ) : current && !current.text ? (
          <div className="empty">(translating page {currentPage}…)</div>
        ) : (
          <div className="empty">
            Page {currentPage}{totalPages > 0 ? ` / ${totalPages}` : ''} not translated yet.<br />
            Click <strong>Translate page {currentPage}</strong> on the left.
          </div>
        )}
        {sourceUrl && hasText && totalPages > 0 && onNextPage && (
          <NextPageCta
            currentPage={currentPage}
            totalPages={totalPages}
            onNext={onNextPage}
          />
        )}
      </div>

      <div className="translation-panel-footer">
        <span className="meta">
          {translatedCount}{totalPages > 0 ? ` / ${totalPages}` : ''} translated · {totalChars.toLocaleString()} chars
        </span>
        <button
          className={`import-btn ${imported ? 'imported' : ''}`}
          onClick={() => onImport?.()}
          disabled={!canImport}
          title={
            imported
              ? 'Already imported. Translate more pages then click again to refresh.'
              : undefined
          }
        >
          <FileDown size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          {imported ? 'Re-import as material' : 'Import as material'}
        </button>
      </div>
    </div>
  );
}

function NextPageCta({
  currentPage,
  totalPages,
  onNext,
}: {
  currentPage: number;
  totalPages: number;
  onNext: () => void;
}) {
  const isLast = currentPage >= totalPages;
  return (
    <div className="next-page-cta">
      <button
        type="button"
        className="next-page-btn"
        onClick={() => {
          if (!isLast) onNext();
        }}
        disabled={isLast}
        aria-label={isLast ? '本教材結束' : `前往下一頁 page ${currentPage + 1}`}
      >
        {isLast ? (
          '本教材結束'
        ) : (
          <>
            下一頁 · page {currentPage + 1}
            <ChevronRight size={14} strokeWidth={1.75} />
          </>
        )}
      </button>
    </div>
  );
}
