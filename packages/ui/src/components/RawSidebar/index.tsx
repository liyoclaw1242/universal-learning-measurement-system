// RawSidebar — left pane of the Wiki tab in "Raw materials" mode.
// Lists resources from ~/.ulms-wiki/raw/<type>/<id>/ grouped by type
// with a search filter. Pure presentational; host owns selection.

import {
  FileCode2,
  FileText,
  Image as ImageIcon,
  Newspaper,
  Search,
  Youtube,
} from 'lucide-react';
import type { RawResourceSummary } from '../../types/home';

interface RawSidebarProps {
  resources: RawResourceSummary[];
  filter: string;
  /** "<type>/<id>" — both fields needed since ids are not globally unique. */
  selectedKey: string | null;
  loadError?: string | null;
  onFilterChange: (s: string) => void;
  onSelect: (type: string, id: string) => void;
}

const GROUP_ORDER: Array<{ key: string; label: string }> = [
  { key: 'paper', label: 'Papers' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'article', label: 'Articles' },
  { key: 'image', label: 'Images' },
  { key: 'markdown', label: 'Markdown' },
];

export default function RawSidebar({
  resources,
  filter,
  selectedKey,
  loadError,
  onFilterChange,
  onSelect,
}: RawSidebarProps) {
  const trimmed = filter.trim().toLowerCase();
  const filtered = !trimmed
    ? resources
    : resources.filter(
        (r) =>
          r.title.toLowerCase().includes(trimmed) ||
          r.id.toLowerCase().includes(trimmed) ||
          r.sourceUrl.toLowerCase().includes(trimmed) ||
          r.type.toLowerCase().includes(trimmed),
      );

  const groups = GROUP_ORDER.map((g) => ({
    ...g,
    items: filtered.filter((r) => r.type === g.key),
  })).filter((g) => g.items.length > 0);

  return (
    <aside className="wiki-sidebar" aria-label="raw materials list">
      <div className="wiki-sidebar-head">
        <div className="search-box">
          <Search size={11} strokeWidth={1.5} />
          <input
            type="text"
            placeholder="filter raw materials"
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            spellCheck={false}
          />
        </div>
        <span className="ulms-meta">
          {filtered.length} / {resources.length}
        </span>
      </div>
      <div className="wiki-sidebar-list">
        {loadError ? (
          <div className="empty">load failed: {loadError}</div>
        ) : resources.length === 0 ? (
          <div className="empty">
            No raw materials yet. Use the <strong>ULMS Learn</strong> Chrome extension
            on a YouTube watch page or article, or import a paper via Learn.
          </div>
        ) : groups.length === 0 ? (
          <div className="empty">No matches for "{filter}"</div>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="raw-group">
              <div className="raw-group-head">
                {iconForType(g.key)}
                <span>{g.label}</span>
                <span className="ulms-meta">{g.items.length}</span>
              </div>
              {g.items.map((r) => {
                const key = `${r.type}/${r.id}`;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`concept-row ${key === selectedKey ? 'selected' : ''}`}
                    onClick={() => onSelect(r.type, r.id)}
                    title={r.sourceUrl || r.title}
                  >
                    <span className="concept-title">{r.title || r.id}</span>
                    <span className="concept-meta">
                      {r.verified && (
                        <span className="badge edited" title="verified">
                          ✓
                        </span>
                      )}
                      {r.quizzedCount > 0 && (
                        <span className="badge edited" title="used in quiz runs">
                          {r.quizzedCount}×
                        </span>
                      )}
                      <code className="slug">{r.id}</code>
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function iconForType(type: string) {
  switch (type) {
    case 'youtube':
      return <Youtube size={12} strokeWidth={1.5} />;
    case 'article':
      return <Newspaper size={12} strokeWidth={1.5} />;
    case 'paper':
      return <FileText size={12} strokeWidth={1.5} />;
    case 'image':
      return <ImageIcon size={12} strokeWidth={1.5} />;
    case 'markdown':
      return <FileCode2 size={12} strokeWidth={1.5} />;
    default:
      return <FileText size={12} strokeWidth={1.5} />;
  }
}
