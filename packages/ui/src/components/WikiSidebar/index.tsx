// WikiSidebar — concept list with search filter (left pane of the
// Wiki tab). Pure presentational; the host owns load + selection
// state and threads handlers down.

import { Edit3, Search } from 'lucide-react';
import type { WikiConceptMeta } from '../../types/wiki';

interface WikiSidebarProps {
  concepts: WikiConceptMeta[];
  filter: string;
  selectedSlug: string | null;
  loadError?: string | null;
  onFilterChange: (s: string) => void;
  onSelect: (slug: string) => void;
}

export default function WikiSidebar({
  concepts,
  filter,
  selectedSlug,
  loadError,
  onFilterChange,
  onSelect,
}: WikiSidebarProps) {
  const trimmed = filter.trim().toLowerCase();
  const filtered = !trimmed
    ? concepts
    : concepts.filter(
        (c) =>
          c.title.toLowerCase().includes(trimmed) ||
          c.slug.toLowerCase().includes(trimmed) ||
          c.tags.some((t) => t.toLowerCase().includes(trimmed)),
      );

  return (
    <aside className="wiki-sidebar" aria-label="concept list">
      <div className="wiki-sidebar-head">
        <div className="search-box">
          <Search size={11} strokeWidth={1.5} />
          <input
            type="text"
            placeholder="filter concepts"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            spellCheck={false}
          />
          <span className="ulms-kbd">⌘ K</span>
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
              onClick={() => onSelect(c.slug)}
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
  );
}
