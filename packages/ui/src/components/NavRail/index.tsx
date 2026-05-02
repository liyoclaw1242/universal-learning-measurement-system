// NavRail — left rail (260px). Three mode variants:
//   - Inputs  : learn entry point (URL → open paper window)
//   - Running : agent tree
//   - Review  : item outline
//
// Mode switches based on `stage` prop.

import { useState } from 'react';
import { BookOpen, Bot, Flag, ArrowDown, ArrowUp, Check, Globe } from 'lucide-react';
import type { Agent, AgentId, ToolCall } from '../../types/agent';
import type { Item, Agreement, UserOverride } from '../../types/item';
import type { Stage } from '../../types/session';

export interface LearnSession {
  /** session id (8-char uuid prefix) */
  id: string;
  sourceUrl: string;
  captureCount: number;
  streaming: boolean;
}

interface NavRailProps {
  stage: Stage;
  // review variant
  items?: Item[];
  selectedItemId?: string | null;
  onSelectItem?: (id: string) => void;
  // running variant
  agents?: Agent[];
  activeAgentId?: AgentId | null;
  onSelectAgent?: (id: AgentId) => void;
  /** optional expanded agent showing tool list; defaults to activeAgentId */
  expandedAgentId?: AgentId | null;
  // inputs / learn variant
  learnSession?: LearnSession | null;
  onOpenPaper?: (url: string) => void;
}

export default function NavRail(props: NavRailProps) {
  return (
    <aside className="rail" aria-label="navigation rail">
      {props.stage === 'running' ? (
        <RailRunning {...props} />
      ) : props.stage === 'inputs' ? (
        <RailLearn {...props} />
      ) : (
        <RailReview {...props} />
      )}
    </aside>
  );
}

// ─── inputs state — learn entry point (Open paper) ───────────

function RailLearn({ learnSession, onOpenPaper }: NavRailProps) {
  const [url, setUrl] = useState('');
  const trimmed = url.trim();

  return (
    <>
      <div className="rail-head">
        <span className="ulms-label">
          <BookOpen size={12} strokeWidth={1.5} style={{ verticalAlign: 'middle', marginRight: 6 }} />
          learn
        </span>
      </div>
      <div className="rail-scroll" style={{ padding: 12 }}>
        {learnSession ? (
          <div className="learn-session">
            <div className="learn-session-row">
              <Globe size={12} strokeWidth={1.5} />
              <span
                className="learn-session-url"
                title={learnSession.sourceUrl}
              >
                {shortenUrl(learnSession.sourceUrl)}
              </span>
            </div>
            <div className="learn-session-meta">
              session <code>{learnSession.id}</code> · {learnSession.captureCount} capture
              {learnSession.captureCount === 1 ? '' : 's'}
            </div>
            {learnSession.streaming && (
              <div className="learn-session-status">
                <span className="status-dot pulse" />
                translating…
              </div>
            )}
            <div className="ulms-meta" style={{ marginTop: 12 }}>
              switch to the <strong>Learn</strong> tab to capture &amp; review translations.
            </div>
          </div>
        ) : (
          <form
            className="learn-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed && onOpenPaper) onOpenPaper(trimmed);
            }}
          >
            <label className="ulms-meta">paper / arxiv URL</label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://arxiv.org/pdf/2401.10515"
              className="learn-url-input"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="learn-open-btn"
              disabled={!trimmed || !onOpenPaper}
            >
              Open paper
            </button>
            <p className="ulms-meta" style={{ marginTop: 12, lineHeight: 1.4 }}>
              Opens a separate window with the page. Capturing requires
              macOS Screen Recording permission (one-time prompt).
            </p>
          </form>
        )}
      </div>
    </>
  );
}

function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 30 ? '…' + u.pathname.slice(-28) : u.pathname;
    return u.host + tail;
  } catch {
    return url.length > 40 ? url.slice(0, 38) + '…' : url;
  }
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

// ─── running state — agent tree ──────────────────────────────

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
