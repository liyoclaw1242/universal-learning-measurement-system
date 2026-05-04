// PDF reader shell — paper translation only. Storage at
// <wiki>/raw/papers/<paper-id>/, no Quiz export, no other formats.

import { useEffect, useMemo, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { PdfReader, TranslationPanel, type TranslationCapture } from '@ulms/ui';
import { Trash2 } from 'lucide-react';

interface PaperSummary {
  id: string;
  title: string;
  source_url: string;
  captured_at: string;
  page_count: number;
}

interface SessionState {
  id: string;
  source_url: string;
  pdf_path: string;
  session_dir: string;
  body_path: string;
  capture_count: number;
}

interface ResumeResp {
  session: SessionState;
  captures: TranslationCapture[];
}

export default function App() {
  const [urlInput, setUrlInput] = useState('');
  const [recents, setRecents] = useState<PaperSummary[]>([]);
  const [wikiDir, setWikiDir] = useState('');

  const [session, setSession] = useState<SessionState | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const [captures, setCaptures] = useState<TranslationCapture[]>([]);

  const translatedPages = useMemo(
    () => new Set(captures.map((c) => c.index)),
    [captures],
  );

  useEffect(() => {
    void invoke<string>('get_wiki_dir').then(setWikiDir).catch(() => {});
    void refreshRecents();
  }, []);

  // Subscribe to translation events so the panel + page-set update live.
  useEffect(() => {
    let unlisten: UnlistenFn[] = [];
    let cancelled = false;

    const wire = async () => {
      const u1 = await listen<{
        capture_index: number;
        image_path: string;
        text: string;
      }>('translation:completed', (e) => {
        if (cancelled) return;
        setStreaming(false);
        const ts = new Date().toISOString();
        setCaptures((prev) => {
          const filtered = prev.filter((c) => c.index !== e.payload.capture_index);
          return [
            ...filtered,
            {
              index: e.payload.capture_index,
              imagePath: e.payload.image_path,
              text: e.payload.text,
              ts,
            },
          ].sort((a, b) => a.index - b.index);
        });
      });
      const u2 = await listen<{ capture_index: number; image_path: string }>(
        'translation:capture-started',
        (e) => {
          if (cancelled) return;
          setStreaming(true);
          // optimistic placeholder so the panel shows the active page
          setCaptures((prev) => {
            if (prev.some((c) => c.index === e.payload.capture_index)) return prev;
            return [
              ...prev,
              {
                index: e.payload.capture_index,
                imagePath: e.payload.image_path,
                text: '',
                ts: new Date().toISOString(),
              },
            ].sort((a, b) => a.index - b.index);
          });
        },
      );
      const u3 = await listen<{ error: string }>('translation:error', (e) => {
        if (cancelled) return;
        setStreaming(false);
        alert(`Translation failed: ${e.payload.error}`);
      });
      if (cancelled) {
        u1();
        u2();
        u3();
      } else {
        unlisten = [u1, u2, u3];
      }
    };
    void wire();
    return () => {
      cancelled = true;
      for (const u of unlisten) u();
    };
  }, []);

  async function refreshRecents() {
    try {
      const list = await invoke<PaperSummary[]>('list_papers');
      setRecents(list);
    } catch {
      // ignore
    }
  }

  async function onOpenUrl() {
    if (!urlInput.trim()) return;
    try {
      const s = await invoke<SessionState>('start_paper_session', { url: urlInput.trim() });
      setSession(s);
      setCaptures([]);
      setCurrentPage(1);
      setTotalPages(0);
      setUrlInput('');
      await refreshRecents();
    } catch (e) {
      alert(`Open failed: ${e}`);
    }
  }

  async function onResume(id: string) {
    try {
      const r = await invoke<ResumeResp>('resume_paper_session', { paperId: id });
      setSession(r.session);
      setCaptures(r.captures);
      setCurrentPage(1);
      setTotalPages(0);
    } catch (e) {
      alert(`Resume failed: ${e}`);
    }
  }

  async function onDelete(id: string, title: string) {
    if (!confirm(`Delete paper "${title}"? raw/papers/${id}/ will be removed.`)) return;
    try {
      await invoke('delete_paper', { paperId: id });
      if (session?.id === id) {
        setSession(null);
        setCaptures([]);
      }
      await refreshRecents();
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  async function onTranslatePage(pageNum: number, imageB64: string) {
    setStreaming(true);
    try {
      await invoke('translate_page', { pageNum, imageB64 });
    } catch (e) {
      setStreaming(false);
      throw e;
    }
  }

  async function onStopTranslation() {
    try {
      await invoke('stop_translation');
    } catch {
      // ignore
    }
  }

  const pdfUrl = session ? convertFileSrc(session.pdf_path) : null;

  return (
    <div className="reader-shell">
      <header className="reader-hdr">
        <span className="brand">ULMS · PDF READER</span>
        <input
          type="text"
          className="url-input"
          placeholder="https://arxiv.org/pdf/2401.12345  ↵  to open"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onOpenUrl();
          }}
          spellCheck={false}
        />
        <button type="button" onClick={() => void onOpenUrl()} disabled={!urlInput.trim()}>
          Open
        </button>
      </header>

      <div className="reader-body">
        <aside className="reader-recents" aria-label="recent papers">
          <h3>Recent papers</h3>
          {recents.length === 0 ? (
            <div className="empty">No papers yet. Paste an arxiv PDF URL above.</div>
          ) : (
            recents.map((r) => (
              <div
                key={r.id}
                className={`row ${session?.id === r.id ? 'active' : ''}`}
                onClick={() => void onResume(r.id)}
              >
                <span className="title">{r.title || r.id}</span>
                <span className="meta">
                  {r.page_count} page{r.page_count === 1 ? '' : 's'} · {r.captured_at.slice(0, 10)}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDelete(r.id, r.title || r.id);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--ulms-faint)',
                      cursor: 'pointer',
                      padding: 0,
                      marginLeft: 8,
                    }}
                    aria-label="delete"
                    title="delete paper"
                  >
                    <Trash2 size={11} strokeWidth={1.5} />
                  </button>
                </span>
              </div>
            ))
          )}
        </aside>

        <section className="reader-pdf">
          <PdfReader
            pdfUrl={pdfUrl}
            currentPage={currentPage}
            isStreaming={streaming}
            translatedPages={translatedPages}
            onCurrentPageChange={setCurrentPage}
            onTotalPagesChange={setTotalPages}
            onTranslatePage={onTranslatePage}
          />
        </section>

        <section className="reader-translate">
          <TranslationPanel
            sourceUrl={session?.source_url ?? null}
            currentPage={currentPage}
            totalPages={totalPages}
            streaming={streaming}
            captures={captures}
            imported={false}
            onStop={() => void onStopTranslation()}
            onNextPage={() => setCurrentPage((p) => p + 1)}
          />
        </section>
      </div>

      <footer className="reader-ftr">
        <span>{wikiDir}</span>
        <span>raw/papers/ — translations land in body.md</span>
      </footer>
    </div>
  );
}
