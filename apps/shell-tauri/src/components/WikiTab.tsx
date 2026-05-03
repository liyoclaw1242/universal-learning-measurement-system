// Wiki tab — synthesised knowledge base browser + inline editor.
// Left: concept list with search filter. Right: rendered markdown
// (or textarea in edit mode). Top: Synthesize button (rebuilds the
// wiki from raw runs via gemini).

import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import {
  Pencil,
  Save,
  X,
  BookMarked,
  RefreshCw,
  Edit3,
  Search,
} from 'lucide-react';
import { bridge, type WikiConceptMeta } from '@/state/ipcBridge';

export default function WikiTab() {
  const [concepts, setConcepts] = useState<WikiConceptMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [readError, setReadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthMsg, setSynthMsg] = useState<string | null>(null);
  const reloadRef = useRef(0);

  const reloadList = () => {
    setLoadError(null);
    bridge
      .listWikiConcepts()
      .then(setConcepts)
      .catch((e) => setLoadError(String(e)));
  };

  useEffect(() => {
    reloadList();
  }, []);

  // Auto-select the first concept once list loads if none selected.
  useEffect(() => {
    if (!selectedSlug && concepts.length > 0) {
      setSelectedSlug(concepts[0].slug);
    }
  }, [concepts, selectedSlug]);

  // Load content whenever selection changes (and not editing).
  useEffect(() => {
    if (!selectedSlug) {
      setContent('');
      return;
    }
    let cancelled = false;
    setReadError(null);
    bridge
      .readWikiConcept(selectedSlug)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setEditing(false);
        setDraft('');
      })
      .catch((e) => {
        if (cancelled) return;
        setReadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, reloadRef.current]);

  const filtered = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return concepts;
    return concepts.filter(
      (c) =>
        c.title.toLowerCase().includes(needle) ||
        c.slug.toLowerCase().includes(needle) ||
        c.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [concepts, filter]);

  const onStartEdit = () => {
    setDraft(content);
    setEditing(true);
  };

  const onCancelEdit = () => {
    setDraft('');
    setEditing(false);
  };

  const onSave = async () => {
    if (!selectedSlug) return;
    setSaving(true);
    try {
      await bridge.writeWikiConcept(selectedSlug, draft);
      // Re-read the canonical version (with human_edited: true forced).
      const fresh = await bridge.readWikiConcept(selectedSlug);
      setContent(fresh);
      setEditing(false);
      setDraft('');
      // Refresh list so the human-edited flag updates in sidebar.
      reloadList();
    } catch (e) {
      alert(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const onSynthesize = async () => {
    setSynthesizing(true);
    setSynthMsg(null);
    try {
      const r = await bridge.synthesizeWiki();
      setSynthMsg(
        `✓ ${r.conceptsWritten} concept page${r.conceptsWritten === 1 ? '' : 's'} written` +
          (r.skippedHumanEdited.length > 0
            ? ` · ${r.skippedHumanEdited.length} skipped (human-edited)`
            : ''),
      );
      reloadList();
      // Re-read current selection in case its body changed.
      reloadRef.current++;
    } catch (e) {
      alert(`Synthesize failed: ${e}`);
    } finally {
      setSynthesizing(false);
    }
  };

  const selected = concepts.find((c) => c.slug === selectedSlug) ?? null;

  return (
    <div className="wiki-tab">
      <aside className="wiki-sidebar" aria-label="concept list">
        <div className="wiki-sidebar-head">
          <div className="search-box">
            <Search size={12} strokeWidth={1.5} />
            <input
              type="text"
              placeholder="filter concepts"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
          </div>
          <span className="ulms-meta">
            {filtered.length} / {concepts.length}
          </span>
        </div>
        <div className="wiki-sidebar-list">
          {loadError ? (
            <div className="empty">load failed: {loadError}</div>
          ) : concepts.length === 0 ? (
            <div className="empty">
              No concepts yet. Click <strong>Synthesize</strong> on the right after
              completing a Quiz run.
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">No matches for "{filter}"</div>
          ) : (
            filtered.map((c) => (
              <button
                key={c.slug}
                type="button"
                className={`concept-row ${c.slug === selectedSlug ? 'selected' : ''}`}
                onClick={() => setSelectedSlug(c.slug)}
                title={c.tags.length > 0 ? `tags: ${c.tags.join(', ')}` : undefined}
              >
                <span className="concept-title">{c.title}</span>
                <span className="concept-meta">
                  {c.humanEdited && (
                    <span className="badge edited" title="human-edited">
                      <Edit3 size={10} strokeWidth={1.5} />
                    </span>
                  )}
                  <code className="slug">{c.slug}</code>
                </span>
              </button>
            ))
          )}
        </div>
      </aside>

      <section className="wiki-view" aria-label="concept body">
        <header className="wiki-view-head">
          <div className="title">
            {selected ? (
              <>
                <h2>{selected.title}</h2>
                {selected.humanEdited && (
                  <span className="badge edited" title="this page has been hand-edited">
                    <Edit3 size={11} strokeWidth={1.75} /> edited
                  </span>
                )}
              </>
            ) : (
              <h2>(no concept selected)</h2>
            )}
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              onClick={() => void onSynthesize()}
              disabled={synthesizing}
              title="re-synthesise wiki concepts from workspace runs (繁中, gemini)"
            >
              {synthesizing ? (
                <RefreshCw size={13} className="spin" />
              ) : (
                <BookMarked size={13} />
              )}
              {synthesizing ? ' Synthesizing…' : ' Synthesize'}
            </button>
            {selectedSlug &&
              (editing ? (
                <>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={onCancelEdit}
                    disabled={saving}
                  >
                    <X size={13} /> Cancel
                  </button>
                  <button
                    type="button"
                    className="btn primary"
                    onClick={() => void onSave()}
                    disabled={saving}
                  >
                    <Save size={13} /> {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              ) : (
                <button type="button" className="btn ghost" onClick={onStartEdit}>
                  <Pencil size={13} /> Edit
                </button>
              ))}
          </div>
        </header>
        {synthMsg && <div className="wiki-synth-msg">{synthMsg}</div>}
        <div className="wiki-view-body">
          {readError ? (
            <div className="empty">read failed: {readError}</div>
          ) : !selectedSlug ? (
            <div className="empty">
              {concepts.length === 0
                ? 'No concepts in the wiki yet.'
                : 'Pick a concept on the left.'}
            </div>
          ) : editing ? (
            <textarea
              className="wiki-edit-area"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <article className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
              >
                {stripFrontmatter(content)}
              </ReactMarkdown>
            </article>
          )}
        </div>
      </section>
    </div>
  );
}

function stripFrontmatter(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) return raw;
  const after = trimmed.slice(3);
  const close = after.indexOf('\n---');
  if (close < 0) return raw;
  return after.slice(close + 4).trimStart();
}
