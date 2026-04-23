// ItemDetailTab — center-tab body for a single item review screen.
// Handoff §4.3.7: header + 4 action buttons + stem + options + check
// rows (collapsible) + source excerpt + tags.
//
// Step 5.6 is static — action handlers are optional props. Step 7 wires
// real state updates + IPC for override persistence.

import { useState } from 'react';
import { Flag, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type {
  Agreement,
  CheckKey,
  CheckStatus,
  DualCheck,
  Item,
  ItemChecks,
  ItemOption,
} from '../../types/item';

interface ItemDetailTabProps {
  item: Item;
  options?: ItemOption[];
  checks?: ItemChecks;
  sourceExcerpt?: string;
  /** optional code block shown above options (e.g. Rust snippet) */
  stemCode?: string;
  onFlag?: (id: string) => void;
  onReject?: (id: string) => void;
  onPromote?: (id: string) => void;
  onShip?: (id: string) => void;
  /** Step 7d: regenerate just this item. Disabled while busy. */
  onRegenerate?: (id: string) => void;
  /** Whether THIS item is currently being regenerated (agent-3 running) */
  regenerating?: boolean;
}

const CHECK_KEYS: CheckKey[] = ['uniqueness', 'construct', 'workaround', 'ambiguity'];
const CHECK_LABEL: Record<CheckKey, string> = {
  uniqueness: 'Answer uniqueness',
  construct: 'Construct validity',
  workaround: 'Bypass / workaround',
  ambiguity: 'Ambiguity',
};

function AgreementBadge({ agreement }: { agreement: Agreement }) {
  const label =
    agreement === 'accept' ? 'accept · C = G' :
    agreement === 'reject' ? 'reject · C = G' :
    agreement === 'revise' ? 'needs revision · C = G' :
    'disagree · C ≠ G';
  return <span className={`agreement-badge ${agreement}`}>{label}</span>;
}

export default function ItemDetailTab({
  item,
  options,
  checks,
  sourceExcerpt,
  stemCode,
  onFlag,
  onReject,
  onPromote,
  onShip,
  onRegenerate,
  regenerating = false,
}: ItemDetailTabProps) {
  return (
    <div className="item-detail">
      <header className="item-detail-head">
        <div className="head-left">
          <span className="id-mono">{item.id}</span>
          <span className="ulms-meta">·</span>
          <span className="ulms-meta">{item.type}</span>
          <span className="ulms-meta">·</span>
          <span className="ulms-meta">{item.dim}</span>
          <span className="ulms-meta">·</span>
          <span className="ulms-meta">{item.bloom}</span>
        </div>
        <AgreementBadge agreement={item.agreement} />
      </header>

      <div className="item-actions">
        <button
          className="btn xs"
          onClick={() => onFlag?.(item.id)}
          aria-label="flag"
          disabled={regenerating}
        >
          <Flag size={12} strokeWidth={1.5} /> flag
        </button>
        <button
          className="btn xs danger"
          onClick={() => onReject?.(item.id)}
          aria-label="reject"
          disabled={regenerating}
        >
          <ArrowDown size={12} strokeWidth={1.5} /> reject
        </button>
        <button
          className="btn xs"
          onClick={() => onPromote?.(item.id)}
          aria-label="promote"
          disabled={regenerating}
        >
          <ArrowUp size={12} strokeWidth={1.5} /> promote
        </button>
        <button
          className="btn xs primary"
          onClick={() => onShip?.(item.id)}
          aria-label="ship"
          disabled={regenerating}
        >
          <Check size={12} strokeWidth={1.5} /> ship
        </button>
        {onRegenerate && (
          <button
            className={`btn xs ${regenerating ? 'running' : ''}`}
            onClick={() => onRegenerate(item.id)}
            aria-label="regenerate"
            disabled={regenerating}
            title="agent-3 重新生成這一題"
          >
            {regenerating ? <span className="pulse-dot" /> : <RotateCcw size={12} strokeWidth={1.5} />}
            {regenerating ? 'regenerating…' : 'regenerate'}
          </button>
        )}
      </div>

      <div className="stem">{item.stem}</div>

      {stemCode && <pre className="stem-code">{stemCode}</pre>}

      {options && options.length > 0 && (
        <ul className="options">
          {options.map((o) => (
            <li key={o.key} className={o.correct ? 'correct' : ''}>
              <span className="option-key">{o.key}</span>
              <span className="option-text">{o.text}</span>
              {o.correct && <span className="option-mark">正解</span>}
            </li>
          ))}
        </ul>
      )}

      {checks && (
        <section className="checks-section">
          <h3 className="ulms-h3">Reviewer checks</h3>
          <div className="check-rows">
            {CHECK_KEYS.map((k) => (
              <CheckRow key={k} label={CHECK_LABEL[k]} detail={checks[k]} />
            ))}
          </div>
        </section>
      )}

      {sourceExcerpt && (
        <details className="source-excerpt">
          <summary>Source excerpt · {item.source}</summary>
          <pre>{sourceExcerpt}</pre>
        </details>
      )}

      <div className="tags">
        <span className="tag">{item.construct}</span>
        <span className="tag">{item.difficulty}</span>
        <span className="tag">{item.bloom}</span>
        <span className="tag mono">{item.source}</span>
      </div>
    </div>
  );
}

interface CheckRowProps {
  label: string;
  detail: DualCheck;
}

function CheckRow({ label, detail }: CheckRowProps) {
  const [open, setOpen] = useState(false);
  const hasNotes = detail.claude_note.length > 0 || detail.gemini_note.length > 0;
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className={`check-row ${open ? 'open' : ''}`}>
      <div
        className="check-head"
        role="button"
        tabIndex={0}
        onClick={() => hasNotes && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && hasNotes) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <span className="chev">
          {hasNotes ? <Chevron size={12} strokeWidth={1.5} /> : <span style={{ width: 12, display: 'inline-block' }} />}
        </span>
        <span className="check-label">{label}</span>
        <span className="spacer" />
        <VerdictDot who="C" status={detail.claude} />
        <VerdictDot who="G" status={detail.gemini} />
      </div>
      {open && (
        <div className="check-body">
          {detail.claude_note && (
            <div className="note-row">
              <span className="who">Claude</span>
              <p>{detail.claude_note}</p>
            </div>
          )}
          {detail.gemini_note && (
            <div className="note-row">
              <span className="who">Gemini</span>
              <p>{detail.gemini_note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function VerdictDot({ who, status }: { who: string; status: CheckStatus }) {
  return (
    <span className={`verdict-dot ${status}`} title={`${who} · ${status}`}>
      <span className="who">{who}</span>
      <span className="status">{status}</span>
    </span>
  );
}
