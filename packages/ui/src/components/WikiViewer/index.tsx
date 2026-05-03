// WikiViewer — right-pane viewer/editor for the Wiki tab.
// Pure presentational. Markdown rendering uses react-markdown +
// GFM + math (KaTeX); editing replaces the rendered body with a
// monospace textarea.

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
} from 'lucide-react';

interface WikiViewerProps {
  /** Page title to render in the header. Empty string = "no concept selected". */
  title: string;
  /** Slug of the selected concept (drives "no selection" empty state). */
  slug: string | null;
  /** Full markdown content including frontmatter; viewer strips it for display. */
  content: string;
  isHumanEdited: boolean;
  isEditing: boolean;
  isSaving: boolean;
  isSynthesizing: boolean;
  /** Editor draft text (raw markdown including frontmatter). */
  draft: string;
  /** Whether the host has any concepts at all (drives empty-state copy). */
  hasAnyConcept: boolean;
  loadError?: string | null;
  synthMsg?: string | null;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onSynthesize: () => void;
  onDraftChange: (s: string) => void;
}

export default function WikiViewer({
  title,
  slug,
  content,
  isHumanEdited,
  isEditing,
  isSaving,
  isSynthesizing,
  draft,
  hasAnyConcept,
  loadError,
  synthMsg,
  onStartEdit,
  onCancelEdit,
  onSave,
  onSynthesize,
  onDraftChange,
}: WikiViewerProps) {
  return (
    <section className="wiki-view" aria-label="concept body">
      <header className="wiki-view-head">
        <div className="title">
          {slug ? (
            <>
              <h2>{title || slug}</h2>
              {isHumanEdited && (
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
            onClick={onSynthesize}
            disabled={isSynthesizing}
            title="re-synthesise wiki concepts from workspace runs (繁中, gemini)"
          >
            {isSynthesizing ? <RefreshCw size={13} className="spin" /> : <BookMarked size={13} />}
            {isSynthesizing ? ' Synthesizing…' : ' Synthesize'}
          </button>
          {slug &&
            (isEditing ? (
              <>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={onCancelEdit}
                  disabled={isSaving}
                >
                  <X size={13} /> Cancel
                  <span className="ulms-kbd" style={{ marginLeft: 4 }}>esc</span>
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={onSave}
                  disabled={isSaving}
                >
                  <Save size={13} /> {isSaving ? 'Saving…' : 'Save'}
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
        {loadError ? (
          <div className="empty">read failed: {loadError}</div>
        ) : !slug ? (
          <div className="empty">
            {hasAnyConcept ? 'Pick a concept on the left.' : 'No concepts in the wiki yet.'}
          </div>
        ) : isEditing ? (
          <textarea
            className="wiki-edit-area"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
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
