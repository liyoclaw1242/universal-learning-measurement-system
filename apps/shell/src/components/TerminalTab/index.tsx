// TerminalTab — black-background stream log for an agent (or unified).
// Handoff §4.3.8:
//   · [INFO] muted · [WARN] yellow · [ERROR] red · ✓ green
//   · unified tab merges all agents; agent-N tab shows one
//   · blinking `> ` prompt at the bottom (input is wired in step 7)

import { useEffect, useMemo, useRef } from 'react';
import type { AgentId, LogLine, StreamLog } from '@/types/agent';

interface TerminalTabProps {
  agentId: AgentId | 'unified';
  streamLog: StreamLog;
  /** optional; forwarded from state in step 6 */
  onSubmitCommand?: (line: string) => void;
}

export default function TerminalTab({ agentId, streamLog }: TerminalTabProps) {
  const lines = useMemo<LogLine[]>(() => collectLines(agentId, streamLog), [agentId, streamLog]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className="terminal">
      <div className="term-body" ref={bodyRef}>
        {lines.map((line, i) => (
          <div className={`term-line kind-${line.kind}`} key={i}>
            <span className="term-ts">{line.ts}</span>
            <span className="term-kind">{kindTag(line.kind)}</span>
            <span className="term-text">{line.text}</span>
          </div>
        ))}
        <div className="term-prompt" aria-hidden>
          <span>&gt;</span>
          <span className="caret" />
        </div>
      </div>
    </div>
  );
}

function collectLines(agentId: AgentId | 'unified', log: StreamLog): LogLine[] {
  if (agentId === 'unified') {
    const merged: LogLine[] = [];
    for (const key of Object.keys(log) as (keyof StreamLog)[]) {
      if (key === 'unified') continue;
      const v = log[key];
      if (Array.isArray(v)) merged.push(...v);
    }
    merged.sort((a, b) => a.ts.localeCompare(b.ts));
    return merged;
  }
  const v = log[agentId];
  return Array.isArray(v) ? v : [];
}

function kindTag(kind: LogLine['kind']): string {
  switch (kind) {
    case 'thought': return '💬';
    case 'tool': return '🔧';
    case 'result': return '⤷';
    case 'summary': return '∑';
    case 'done': return '✓';
    case 'warn': return '[WARN]';
    case 'error': return '[ERROR]';
  }
}
