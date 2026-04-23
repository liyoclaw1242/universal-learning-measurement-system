// Ribbon — the top three rows of the shell chrome.
// Per design handoff §4.3.1–4.3.3:
//   · ribbon-strip (36px)     session meta, cost chip, export buttons
//   · ribbon-tabs  (32px)     5 tabs + density toggle
//   · ribbon-body  (auto)     contextual content per active tab
//
// This is the step 5.1 static version: props-driven, no store wiring.
// Step 6 swaps the hand-rolled `session` prop for Zustand state.

import type { Session, Stage, Density } from '@/types/session';
import { costStateOf } from '@/types/session';
import { Download, Sparkles } from 'lucide-react';

export type RibbonTab = 'home' | 'inputs' | 'run' | 'settings' | 'tweaks';

const RIBBON_TABS: RibbonTab[] = ['home', 'inputs', 'run', 'settings', 'tweaks'];
const TAB_LABEL: Record<RibbonTab, string> = {
  home: 'Home',
  inputs: 'Inputs',
  run: 'Run',
  settings: 'Settings',
  tweaks: 'Tweaks',
};
const DENSITIES: Density[] = ['compact', 'standard', 'focus'];

interface RibbonProps {
  session: Session;
  stage: Stage;
  activeTab: RibbonTab;
  density: Density;
  onTabChange: (tab: RibbonTab) => void;
  onDensityChange: (d: Density) => void;
  /** optional — only valid in review stage */
  onRunSecondOpinion?: () => void;
  /** optional — only valid in review stage */
  onExport?: () => void;
}

export default function Ribbon(props: RibbonProps) {
  return (
    <>
      <RibbonStrip
        session={props.session}
        stage={props.stage}
        onRunSecondOpinion={props.onRunSecondOpinion}
        onExport={props.onExport}
      />
      <RibbonTabs
        activeTab={props.activeTab}
        onTabChange={props.onTabChange}
        density={props.density}
        onDensityChange={props.onDensityChange}
      />
      <RibbonBody activeTab={props.activeTab} stage={props.stage} />
    </>
  );
}

// ─── strip ────────────────────────────────────────────────────────

interface StripProps {
  session: Session;
  stage: Stage;
  onRunSecondOpinion?: () => void;
  onExport?: () => void;
}

function RibbonStrip({ session, stage, onRunSecondOpinion, onExport }: StripProps) {
  const state = costStateOf(session.cost_usd, session.cost_cap);
  const pct = session.cost_cap > 0 ? Math.min(100, (session.cost_usd / session.cost_cap) * 100) : 0;

  return (
    <div className="ribbon-strip">
      <div className="breadcrumb">
        <span className="brand">ulms</span>
        <span className="sep">›</span>
        <span>{session.project}</span>
        <span className="sep">›</span>
        <span className="session-id">
          session {session.id} · {session.elapsed_s.toFixed(1)}s elapsed
        </span>
      </div>

      <div className="right">
        <span className="cost-chip" data-state={state}>
          <span className="track">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          <span>${session.cost_usd.toFixed(2)}</span>
          <span className="total">/ ${session.cost_cap.toFixed(2)}</span>
        </span>

        {stage === 'review' && (
          <>
            <button className="btn" onClick={onRunSecondOpinion} disabled={!onRunSecondOpinion}>
              <Sparkles size={14} strokeWidth={1.5} />
              Gemini 2nd opinion
            </button>
            <button className="btn primary" onClick={onExport} disabled={!onExport}>
              <Download size={14} strokeWidth={1.5} />
              Export .md + .json
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── tabs ─────────────────────────────────────────────────────────

interface TabsProps {
  activeTab: RibbonTab;
  onTabChange: (tab: RibbonTab) => void;
  density: Density;
  onDensityChange: (d: Density) => void;
}

function RibbonTabs({ activeTab, onTabChange, density, onDensityChange }: TabsProps) {
  return (
    <div className="ribbon-tabs">
      {RIBBON_TABS.map((t) => (
        <div
          key={t}
          className={`tab ${t === activeTab ? 'active' : ''}`}
          onClick={() => onTabChange(t)}
          role="tab"
          aria-selected={t === activeTab}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onTabChange(t);
            }
          }}
        >
          {TAB_LABEL[t]}
        </div>
      ))}
      <div className="spacer" />
      <div className="density-toggle" aria-label="density">
        {DENSITIES.map((d) => (
          <button
            key={d}
            className={d === density ? 'active' : ''}
            onClick={() => onDensityChange(d)}
            aria-pressed={d === density}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── body ─────────────────────────────────────────────────────────

interface BodyProps {
  activeTab: RibbonTab;
  stage: Stage;
}

function RibbonBody({ activeTab, stage }: BodyProps) {
  return (
    <div className="ribbon-body">
      {activeTab === 'home' && <HomeBody stage={stage} />}
      {activeTab === 'inputs' && <InputsBody />}
      {activeTab === 'run' && <RunBody />}
      {(activeTab === 'settings' || activeTab === 'tweaks') && (
        <EmptyBody label={activeTab.toUpperCase()} />
      )}
    </div>
  );
}

// Per handoff §4.3.3: Home = two button clusters separated by a 2px line.
// Concrete button content depends on stage; left cluster is quick session
// actions, right cluster is stage-specific shortcuts. Wiring comes in step 7.
function HomeBody({ stage }: { stage: Stage }) {
  return (
    <div className="home-body">
      <div className="cluster">
        <button className="btn" disabled>
          New session
        </button>
        <button className="btn" disabled>
          Open…
        </button>
      </div>
      <div className="cluster-sep" />
      <div className="cluster">
        {stage === 'inputs' && (
          <button className="btn primary" disabled>
            Start run
          </button>
        )}
        {stage === 'running' && (
          <button className="btn" disabled>
            Pause
          </button>
        )}
        {stage === 'review' && (
          <button className="btn" disabled>
            Re-run from last stage
          </button>
        )}
      </div>
    </div>
  );
}

// Per handoff §4.3.3: three placeholder file slots (syllabus / textbook /
// transcript), drop zones. Visual only here; actual picker + IPC in step 7.
function InputsBody() {
  const slots = [
    { label: 'SYLLABUS', hint: '拖放或選擇 .md / .txt' },
    { label: 'TEXTBOOK', hint: '拖放或選擇 .md / .txt' },
    { label: 'TRANSCRIPT', hint: '拖放或選擇 .md / .txt（可選）' },
  ];
  return (
    <div className="inputs-body">
      {slots.map((s) => (
        <div className="slot-placeholder" key={s.label}>
          <span className="ulms-label">{s.label}</span>
          <span className="ulms-meta">{s.hint}</span>
        </div>
      ))}
    </div>
  );
}

// Per handoff §4.3.3: pause / interrupt + live status text.
function RunBody() {
  return (
    <div className="run-body">
      <button className="btn" disabled>
        Pause
      </button>
      <button className="btn danger" disabled>
        Interrupt
      </button>
      <span className="ulms-meta">running · — of 4 agents active</span>
    </div>
  );
}

function EmptyBody({ label }: { label: string }) {
  return <span className="ulms-label">{label}</span>;
}
