// PDF reader pane — left half of the Learn tab.
//
// Loads a PDF via Tauri's asset protocol (pdfUrl is the result of
// `convertFileSrc(abs_path_to_pdf)`), renders one page at a time on a
// canvas, and provides Prev/Next/jump and "Translate this page"
// controls. The translate flow:
//   1. canvas.toBlob('image/png') — produces a Blob
//   2. FileReader.readAsDataURL → "data:image/png;base64,XYZ..."
//   3. strip the data: prefix → b64 string
//   4. onTranslatePage(pageNum, b64) → renderer's bridge invokes
//      `translate_page` Tauri command which writes the PNG and spawns
//      gemini.

import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
// Vite handles `?url` imports for assets — pdfjs's worker comes back
// as a hash-stamped URL string that the lib points GlobalWorkerOptions at.
import workerSrcUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, Languages, Check, Layers, Square } from 'lucide-react';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcUrl;

interface PdfReaderProps {
  pdfUrl: string | null;
  currentPage: number;
  isStreaming: boolean;
  /** set of page numbers that already have a translation */
  translatedPages: Set<number>;
  onCurrentPageChange: (n: number) => void;
  onTotalPagesChange: (n: number) => void;
  /** Returns a Promise that resolves when the backend finishes the
   *  translation for this page (gemini streamed + notes.md appended).
   *  The batch loop awaits this so pages are processed sequentially —
   *  gemini CLI can't handle 3+ images concurrently. */
  onTranslatePage: (pageNum: number, imageB64: string) => Promise<void>;
}

export default function PdfReader({
  pdfUrl,
  currentPage,
  isStreaming,
  translatedPages,
  onCurrentPageChange,
  onTotalPagesChange,
  onTranslatePage,
}: PdfReaderProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [batchProgress, setBatchProgress] = useState<{
    cur: number;
    total: number;
    skipped: number[];
  } | null>(null);
  const cancelBatchRef = useRef(false);
  /** Tracks the current PDF.js RenderTask so we can cancel it before
   *  starting another render — concurrent renders to the same canvas
   *  raise "Cannot use the same canvas during multiple render()". */
  const renderTaskRef = useRef<RenderTask | null>(null);

  // Load PDF whenever url changes.
  useEffect(() => {
    if (!pdfUrl) {
      setPdf(null);
      setLoadError(null);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    pdfjsLib
      .getDocument(pdfUrl)
      .promise.then((doc) => {
        if (cancelled) return;
        setPdf(doc);
        onTotalPagesChange(doc.numPages);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(String(err?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
    // onTotalPagesChange is a stable store action; no need to depend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfUrl]);

  /** Render a page to the on-screen canvas, cancelling any in-flight
   *  render first. Centralising this avoids the dual-render race. */
  const renderPage = useCallback(
    async (pdfDoc: PDFDocumentProxy, pageNum: number) => {
      // Cancel previous task; await its rejection so the canvas is free.
      const prev = renderTaskRef.current;
      if (prev) {
        prev.cancel();
        try {
          await prev.promise;
        } catch {
          // PDF.js rejects with a RenderingCancelledException — expected.
        }
        if (renderTaskRef.current === prev) renderTaskRef.current = null;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
    },
    [],
  );

  // Re-render whenever pdf doc or page changes (single-page nav).
  useEffect(() => {
    if (!pdf) return;
    setRenderError(null);
    let stale = false;
    renderPage(pdf, currentPage).catch((err) => {
      // Cancellation is expected when this effect re-fires before the
      // previous render finishes — silently ignore that one.
      if (err && err.name === 'RenderingCancelledException') return;
      if (stale) return;
      setRenderError(String(err?.message ?? err));
    });
    return () => {
      stale = true;
    };
  }, [pdf, currentPage, renderPage]);

  const captureCanvasB64 = useCallback(async (): Promise<string | null> => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    );
    if (!blob) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        const idx = dataUrl.indexOf(',');
        resolve(idx < 0 ? null : dataUrl.slice(idx + 1));
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }, []);

  const handleTranslate = useCallback(async () => {
    const b64 = await captureCanvasB64();
    if (!b64) return;
    void onTranslatePage(currentPage, b64);
  }, [currentPage, onTranslatePage, captureCanvasB64]);

  const handleTranslateAll = useCallback(async () => {
    if (!pdf || batchProgress) return;
    cancelBatchRef.current = false;
    const total = pdf.numPages;
    const skipped: number[] = [];
    setBatchProgress({ cur: 0, total, skipped });
    try {
      for (let p = 1; p <= total; p++) {
        if (cancelBatchRef.current) break;
        setBatchProgress({ cur: p, total, skipped: [...skipped] });
        onCurrentPageChange(p);

        if (!canvasRef.current) break;

        // Render via the same shared helper as the nav-driven render
        // so the cancel-then-render lock prevents canvas conflicts.
        try {
          await renderPage(pdf, p);
        } catch (err) {
          console.error(`render page ${p} failed`, err);
          skipped.push(p);
          continue;
        }

        const b64 = await captureCanvasB64();
        if (!b64) {
          skipped.push(p);
          continue;
        }

        try {
          // Sequential await — backend gates on a streaming flag, so
          // any concurrent translate_page would Err out anyway.
          await onTranslatePage(p, b64);
        } catch (err) {
          console.error(`translate page ${p} failed`, err);
          skipped.push(p);
          // continue with next page rather than aborting the whole batch
        }
      }
    } finally {
      setBatchProgress(null);
      cancelBatchRef.current = false;
    }
  }, [pdf, batchProgress, onCurrentPageChange, onTranslatePage, captureCanvasB64, renderPage]);

  const handleStopBatch = useCallback(() => {
    cancelBatchRef.current = true;
  }, []);

  const totalPages = pdf?.numPages ?? 0;
  const isTranslated = translatedPages.has(currentPage);

  return (
    <div className="pdf-reader">
      <div className="pdf-reader-toolbar">
        <button
          className="page-btn"
          onClick={() => onCurrentPageChange(Math.max(1, currentPage - 1))}
          disabled={!pdf || currentPage <= 1}
          aria-label="previous page"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="page-indicator">
          Page{' '}
          <input
            type="number"
            value={currentPage}
            min={1}
            max={totalPages || 1}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && (totalPages === 0 || n <= totalPages)) {
                onCurrentPageChange(n);
              }
            }}
            className="page-input"
          />
          {' '}/ {totalPages || '—'}
        </span>
        <button
          className="page-btn"
          onClick={() => onCurrentPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={!pdf || currentPage >= totalPages}
          aria-label="next page"
        >
          <ChevronRight size={14} />
        </button>
        <div style={{ flex: 1 }} />
        {isTranslated && !batchProgress && (
          <span className="translated-badge" title="this page is already translated">
            <Check size={12} /> translated
          </span>
        )}
        {batchProgress ? (
          <>
            <span className="batch-progress" aria-live="polite">
              {batchProgress.cur} / {batchProgress.total}
              {batchProgress.skipped.length > 0
                ? ` · ${batchProgress.skipped.length} skipped`
                : ''}
            </span>
            <button
              className="translate-btn"
              onClick={handleStopBatch}
              style={{
                background: 'var(--ulms-red, #c0392b)',
                borderColor: 'var(--ulms-red, #c0392b)',
              }}
              title="Stop after the current page finishes"
            >
              <Square size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Stop batch
            </button>
          </>
        ) : (
          <>
            <button
              className="translate-btn"
              onClick={() => void handleTranslate()}
              disabled={!pdf || isStreaming}
              title="Render this page and send to gemini for translation"
            >
              <Languages size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              {isStreaming
                ? 'Translating…'
                : isTranslated
                  ? 'Re-translate page'
                  : `Translate page ${currentPage}`}
            </button>
            <button
              className="translate-btn translate-all-btn"
              onClick={() => void handleTranslateAll()}
              disabled={!pdf || isStreaming}
              title="Translate every page sequentially (one at a time — gemini CLI doesn't accept 3+ images per call)"
            >
              <Layers size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Translate all
            </button>
          </>
        )}
      </div>
      <div className="pdf-reader-canvas-wrap">
        {!pdfUrl ? (
          <div className="empty">Paste a PDF URL in the left rail to begin.</div>
        ) : loadError ? (
          <div className="error">PDF load failed: {loadError}</div>
        ) : !pdf ? (
          <div className="empty">Loading PDF…</div>
        ) : (
          <>
            <canvas ref={canvasRef} className="pdf-page-canvas" />
            {renderError && <div className="error">render error: {renderError}</div>}
          </>
        )}
      </div>
    </div>
  );
}
