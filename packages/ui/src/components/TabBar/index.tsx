// TabBar — Chrome/VSCode-style tab strip at top of center region.
// Handoff §4.3.5: Overview unclosable · terminal tabs prefixed with ⛭ ·
// closable tabs show × (only visible on hover of the tab) · trailing +.

import { Settings as Cog, X, Plus } from 'lucide-react';

export type TabId = string;

export interface Tab {
  id: TabId;
  label: string;
  /** show ⛭ glyph prefix — terminal / settings-like tabs */
  glyph?: 'cog' | null;
  closable?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: TabId;
  onActivate: (id: TabId) => void;
  onClose?: (id: TabId) => void;
  onAdd?: () => void;
}

export default function TabBar({ tabs, activeTabId, onActivate, onClose, onAdd }: TabBarProps) {
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((t) => (
        <TabEl
          key={t.id}
          tab={t}
          active={t.id === activeTabId}
          onActivate={() => onActivate(t.id)}
          onClose={t.closable && onClose ? () => onClose(t.id) : undefined}
        />
      ))}
      {onAdd && (
        <span className="tab-add" onClick={onAdd} role="button" aria-label="add tab" tabIndex={0}>
          <Plus size={12} strokeWidth={1.5} />
        </span>
      )}
    </div>
  );
}

interface TabElProps {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose?: () => void;
}

function TabEl({ tab, active, onActivate, onClose }: TabElProps) {
  return (
    <div
      className={`tab ${active ? 'active' : ''}`}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {tab.glyph === 'cog' && (
        <span className="glyph">
          <Cog size={11} strokeWidth={1.5} />
        </span>
      )}
      <span>{tab.label}</span>
      {onClose && (
        <span
          className="close"
          role="button"
          aria-label={`close ${tab.label}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
        >
          <X size={12} strokeWidth={1.5} />
        </span>
      )}
    </div>
  );
}
