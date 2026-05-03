// RecentSessionRow — generic clickable list row used by Home for both
// "recent learn sessions" and "recent quiz runs". Hover-revealed
// trash icon on the right; click on body fires onActivate.

import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';

interface RecentSessionRowProps {
  /** leading icon (lucide-react element from caller — keeps type chip-thin) */
  icon: ReactNode;
  /** primary line shown larger; truncated with ellipsis when too long */
  title: string;
  /** optional tooltip on the title cell (full URL etc.) */
  titleTooltip?: string;
  /** trailing meta row (mono, muted): "5 pages · 2h ago" etc. */
  meta: ReactNode;
  onActivate?: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
}

export default function RecentSessionRow({
  icon,
  title,
  titleTooltip,
  meta,
  onActivate,
  onDelete,
  deleteLabel,
}: RecentSessionRowProps) {
  return (
    <li className="recent-row">
      <button
        type="button"
        className="recent-row-main"
        onClick={onActivate}
        style={{ cursor: onActivate ? 'pointer' : 'default' }}
      >
        {icon}
        <span className="recent-url" title={titleTooltip ?? title}>
          {title}
        </span>
        <span className="recent-meta">{meta}</span>
      </button>
      {onDelete && (
        <button
          type="button"
          className="recent-row-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title={deleteLabel ?? 'delete'}
          aria-label={deleteLabel ?? 'delete'}
        >
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      )}
    </li>
  );
}
