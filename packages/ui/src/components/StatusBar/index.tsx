// StatusBar — bottom 22px row. Handoff §4.3.9.
// Black bg, mono 10px, status dot + session + material left, stage toggle
// + version right. Stage toggle is dev-only (prod derives stage from
// session.status); we keep it here for prototype use and will remove it
// once stage is driven by real IPC.

import type { Session, Stage } from '../../types/session';

type DotColor = 'green' | 'yellow' | 'red';

interface StatusBarProps {
  session: Session;
  stage: Stage;
  /** dev-only: cycles through inputs → running → review */
  onToggleStage?: (next: Stage) => void;
  /** e.g. "v0.1 step-5.2" */
  versionLabel?: string;
}

function dotForStage(stage: Stage, status: Session['status']): DotColor {
  if (status === 'failed') return 'red';
  if (stage === 'running') return 'yellow';
  return 'green';
}

function stageWord(stage: Stage): string {
  if (stage === 'running') return 'running';
  if (stage === 'review') return 'ready';
  return 'awaiting inputs';
}

const STAGE_ORDER: Stage[] = ['inputs', 'running', 'review'];
function nextStage(s: Stage): Stage {
  const i = STAGE_ORDER.indexOf(s);
  return STAGE_ORDER[(i + 1) % STAGE_ORDER.length];
}

export default function StatusBar({
  session,
  stage,
  onToggleStage,
  versionLabel = 'ULMS · v0.1',
}: StatusBarProps) {
  const dot = dotForStage(stage, session.status);

  return (
    <div className="statusbar">
      <span className="item">
        <span className={`dot ${dot}`} />
        {stageWord(stage)}
      </span>
      <span className="item">session {session.id}</span>
      <span className="item truncable">{session.material}</span>
      <span className="spacer" />
      {onToggleStage && (
        <span
          className="item"
          style={{ cursor: 'pointer' }}
          onClick={() => onToggleStage(nextStage(stage))}
          title="dev-only: cycle stage"
        >
          toggle stage → {nextStage(stage)}
        </span>
      )}
      <span className="item">{versionLabel}</span>
    </div>
  );
}
