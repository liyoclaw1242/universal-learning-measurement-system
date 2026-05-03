// ModeBar — top-of-window selector switching between the three
// top-level workspaces: Home, Learn, Quiz.

import { Home, BookOpen, ClipboardCheck, BookMarked } from 'lucide-react';
import type { Mode } from '../../types/session';

interface ModeBarProps {
  mode: Mode;
  onModeChange: (m: Mode) => void;
  /** Optional dot indicator for Learn mode when a paper session is open
   *  but the user is in another mode (e.g., Quiz reviewing items). */
  learnHasSession?: boolean;
  /** Optional dot indicator for Quiz mode when a workflow is running
   *  in the background. */
  quizRunning?: boolean;
}

interface ModeDef {
  id: Mode;
  label: string;
  icon: typeof Home;
  hint: string;
}

const MODES: ModeDef[] = [
  { id: 'home', label: 'Home', icon: Home, hint: 'overview & recent sessions' },
  { id: 'learn', label: 'Learn', icon: BookOpen, hint: 'read & translate papers' },
  { id: 'quiz', label: 'Quiz', icon: ClipboardCheck, hint: 'generate assessment items' },
  { id: 'wiki', label: 'Wiki', icon: BookMarked, hint: 'synthesised knowledge base' },
];

export default function ModeBar({
  mode,
  onModeChange,
  learnHasSession,
  quizRunning,
}: ModeBarProps) {
  return (
    <nav className="mode-bar" aria-label="workspace mode">
      <div className="mode-bar-brand">ULMS</div>
      <div className="mode-bar-tabs" role="tablist">
        {MODES.map((m) => {
          const Icon = m.icon;
          const active = mode === m.id;
          const dot =
            (m.id === 'learn' && learnHasSession && !active) ||
            (m.id === 'quiz' && quizRunning && !active);
          return (
            <button
              key={m.id}
              role="tab"
              aria-selected={active}
              className={`mode-tab ${active ? 'active' : ''}`}
              onClick={() => onModeChange(m.id)}
              title={m.hint}
            >
              <Icon size={14} strokeWidth={1.75} />
              <span>{m.label}</span>
              {dot && <span className="mode-dot" aria-hidden />}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
