// NavRail — left rail (260px). Two mode variants:
//   - Review  : item outline (step 5.3, this file's primary mode)
//   - Running : agent tree (step 5.8, added in its own step)
//
// Mode switches based on `stage` prop. In Running stage the outline is
// irrelevant; in Review stage the agent tree is historical and hidden.

import { BookOpen, Bot, Flag, ArrowDown, ArrowUp, Check } from 'lucide-react';
import type { Agent, AgentId, ToolCall } from '@/types/agent';
import type { Item, Agreement, UserOverride } from '@/types/item';
import type { Stage } from '@/types/session';

interface NavRailProps {
  stage: Stage;
  // review variant
  items?: Item[];
  selectedItemId?: string | null;
  onSelectItem?: (id: string) => void;
  // running variant (step 5.8)
  agents?: Agent[];
  activeAgentId?: AgentId | null;
  onSelectAgent?: (id: AgentId) => void;
  /** optional expanded agent showing tool list; defaults to activeAgentId */
  expandedAgentId?: AgentId | null;
}

export default function NavRail(props: NavRailProps) {
  return (
    <aside className="rail" aria-label="navigation rail">
      {props.stage === 'running' ? <RailRunning {...props} /> : <RailReview {...props} />}
    </aside>
  );
}

// ─── review state — item outline ─────────────────────────────

function RailReview({ items = [], selectedItemId, onSelectItem }: NavRailProps) {
  return (
    <>
      <div className="rail-head">
        <span className="ulms-label">
          <BookOpen size={12} strokeWidth={1.5} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          items
        </span>
        <span className="count">({items.length})</span>
      </div>
      <div className="rail-scroll">
        {items.map((it) => (
          <ItemRow
            key={it.id}
            item={it}
            selected={it.id === selectedItemId}
            onSelect={() => onSelectItem?.(it.id)}
          />
        ))}
      </div>
    </>
  );
}

interface ItemRowProps {
  item: Item;
  selected: boolean;
  onSelect: () => void;
}

// Numeric id shown in col 1, stripped from "item_003" → "003".
function shortId(id: string): string {
  const m = id.match(/(\d+)$/);
  return m ? m[1] : id;
}

function agreementGlyph(a: Agreement): string {
  // The column is only 16px wide — we rely on CSS colour from .verdict.<state>
  switch (a) {
    case 'accept': return '✓';
    case 'reject': return '✗';
    case 'revise': return '~';
    case 'disagree': return '≠';
  }
}

function overrideIcon(u: UserOverride) {
  switch (u) {
    case 'flag': return <Flag size={12} strokeWidth={1.5} />;
    case 'reject': return <ArrowDown size={12} strokeWidth={1.5} />;
    case 'promote': return <ArrowUp size={12} strokeWidth={1.5} />;
    case 'ship': return <Check size={12} strokeWidth={1.5} />;
    default: return null;
  }
}

function ItemRow({ item, selected, onSelect }: ItemRowProps) {
  return (
    <div
      className={`item-row ${selected ? 'selected' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="id">{shortId(item.id)}</span>
      <span className={`verdict ${item.agreement}`} title={`C=${item.claude} / G=${item.gemini}`}>
        {agreementGlyph(item.agreement)}
      </span>
      <span className="stem" title={item.stem}>
        {item.stem}
      </span>
      <span className="override" aria-label={item.user ?? undefined}>
        {overrideIcon(item.user)}
      </span>
    </div>
  );
}

// ─── running state — agent tree (step 5.8) ───────────────────

function RailRunning({
  agents = [],
  activeAgentId,
  onSelectAgent,
  expandedAgentId,
}: NavRailProps) {
  return (
    <>
      <div className="rail-head">
        <span className="ulms-label">
          <Bot size={12} strokeWidth={1.5} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          agents
        </span>
        <span className="count">({agents.length})</span>
      </div>
      <div className="rail-scroll">
        {agents.map((a) => {
          const expanded = (expandedAgentId ?? activeAgentId) === a.id;
          return (
            <AgentNode
              key={a.id}
              agent={a}
              active={a.id === activeAgentId}
              expanded={expanded}
              onSelect={() => onSelectAgent?.(a.id)}
            />
          );
        })}
      </div>
    </>
  );
}

interface AgentNodeProps {
  agent: Agent;
  active: boolean;
  expanded: boolean;
  onSelect: () => void;
}

function AgentNode({ agent, active, expanded, onSelect }: AgentNodeProps) {
  const className = [
    'agent-node',
    agent.status === 'done' && 'done',
    agent.status === 'active' && 'active',
    agent.status === 'pending' && 'pending',
    active && 'active', // highlight overrides done/pending colour
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} onClick={onSelect} role="button" tabIndex={0}>
      <div className="head">
        <span className="status-dot" />
        <span>{agent.name}</span>
        <span className="meta-end">{agent.emit}</span>
      </div>
      {expanded && (
        <div className="tools">
          {agent.tools.map((t: ToolCall, i: number) => (
            <div className="tool" key={i}>
              <span className="glyph">{t.glyph}</span>
              <span>{t.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
