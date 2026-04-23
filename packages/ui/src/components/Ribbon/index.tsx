// Ribbon — the top three rows of the shell chrome.
// Per design handoff §4.3.1–4.3.3:
//   · ribbon-strip (36px)     session meta, cost chip, export buttons
//   · ribbon-tabs  (32px)     5 tabs + density toggle
//   · ribbon-body  (auto)     contextual content per active tab
//
// This is the step 5.1 static version: props-driven, no store wiring.
// Step 6 swaps the hand-rolled `session` prop for Zustand state.

import type { Session, Stage, Density } from '../../types/session';
import { costStateOf } from '../../types/session';
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

  // ─── Inputs / Home body wiring (step 7a) ──────────────
  /** Handler for picking the material file (Home + Inputs bodies) */
  onPickMaterial?: () => void;
  /** Handler for picking the dimensions YAML */
  onPickDimensions?: () => void;
  /** Handler for picking the optional guidance file */
  onPickGuidance?: () => void;
  /** Handler for clearing the staged guidance file */
  onClearGuidance?: () => void;
  /** Handler for starting the workflow (Home body Start button) */
  onStartWorkflow?: () => void;
  /** Currently-staged material filename (shown in input slot) */
  materialFilename?: string | null;
  /** Number of dimensions currently loaded */
  dimensionCount?: number;
  /** Whether guidance is loaded */
  hasGuidance?: boolean;
  /** Whether material + dimensions are both present — Start button gate */
  inputsReady?: boolean;

  // ─── Gemini progress + review summary (step 7c) ───────
  /** Gemini is currently running — button flips to "評審中" state */
  geminiRunning?: boolean;
  /** Elapsed seconds since Gemini started (App.tsx drives this tick) */
  geminiElapsedS?: number;
  /** Post-merge summary; displays agreement % badge when present */
  reviewSummary?: {
    verdict_agreement_rate: number;
    merged_verdict_counts: { accept: number; needs_revision: number; reject: number };
  } | null;

  // ─── Regenerate (step 7d) ───────────────────────────
  /** Count of items currently marked user_override='reject'. Visible
   *  value is also used to enable/disable the batch button. */
  rejectedCount?: number;
  /** Handler for re-running all rejected items (batch) */
  onRerunRejected?: () => void;
  /** Batch progress — remaining count (0 when idle) */
  rerunBatchRemaining?: number;
}

export default function Ribbon(props: RibbonProps) {
  return (
    <>
      <RibbonStrip
        session={props.session}
        stage={props.stage}
        onRunSecondOpinion={props.onRunSecondOpinion}
        onExport={props.onExport}
        geminiRunning={props.geminiRunning}
        geminiElapsedS={props.geminiElapsedS}
        reviewSummary={props.reviewSummary}
        rejectedCount={props.rejectedCount}
        onRerunRejected={props.onRerunRejected}
        rerunBatchRemaining={props.rerunBatchRemaining}
      />
      <RibbonTabs
        activeTab={props.activeTab}
        onTabChange={props.onTabChange}
        density={props.density}
        onDensityChange={props.onDensityChange}
      />
      <RibbonBody
        activeTab={props.activeTab}
        stage={props.stage}
        onPickMaterial={props.onPickMaterial}
        onPickDimensions={props.onPickDimensions}
        onPickGuidance={props.onPickGuidance}
        onClearGuidance={props.onClearGuidance}
        onStartWorkflow={props.onStartWorkflow}
        materialFilename={props.materialFilename}
        dimensionCount={props.dimensionCount}
        hasGuidance={props.hasGuidance}
        inputsReady={props.inputsReady}
      />
    </>
  );
}

// ─── strip ────────────────────────────────────────────────────────

interface StripProps {
  session: Session;
  stage: Stage;
  onRunSecondOpinion?: () => void;
  onExport?: () => void;
  geminiRunning?: boolean;
  geminiElapsedS?: number;
  reviewSummary?: RibbonProps['reviewSummary'];
  rejectedCount?: number;
  onRerunRejected?: () => void;
  rerunBatchRemaining?: number;
}

function RibbonStrip({
  session,
  stage,
  onRunSecondOpinion,
  onExport,
  geminiRunning,
  geminiElapsedS,
  reviewSummary,
  rejectedCount = 0,
  onRerunRejected,
  rerunBatchRemaining = 0,
}: StripProps) {
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
        {reviewSummary && (
          <span
            className="agreement-chip"
            title={`accept ${reviewSummary.merged_verdict_counts.accept} · needs_revision ${reviewSummary.merged_verdict_counts.needs_revision} · reject ${reviewSummary.merged_verdict_counts.reject}`}
          >
            <span>C = G</span>
            <span className="agreement-pct">
              {(reviewSummary.verdict_agreement_rate * 100).toFixed(0)}%
            </span>
          </span>
        )}

        <span className="cost-chip" data-state={state}>
          <span className="track">
            <span className="fill" style={{ width: `${pct}%` }} />
          </span>
          <span>${session.cost_usd.toFixed(2)}</span>
          <span className="total">/ ${session.cost_cap.toFixed(2)}</span>
        </span>

        {stage === 'review' && (
          <>
            {rerunBatchRemaining > 0 ? (
              <button className="btn running" disabled aria-live="polite">
                <span className="pulse-dot" />
                Re-running · {rerunBatchRemaining} left
              </button>
            ) : rejectedCount > 0 ? (
              <button
                className="btn"
                onClick={onRerunRejected}
                disabled={!onRerunRejected}
                title="agent-3 重新生成所有被 reject 的題目"
              >
                Re-run rejected ({rejectedCount})
              </button>
            ) : null}
            {geminiRunning ? (
              <button className="btn running" disabled aria-live="polite">
                <span className="pulse-dot" />
                Gemini 評審中 · {(geminiElapsedS ?? 0).toFixed(0)}s
              </button>
            ) : (
              <button className="btn" onClick={onRunSecondOpinion} disabled={!onRunSecondOpinion}>
                <Sparkles size={14} strokeWidth={1.5} />
                Gemini 2nd opinion
              </button>
            )}
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
  onPickMaterial?: () => void;
  onPickDimensions?: () => void;
  onPickGuidance?: () => void;
  onClearGuidance?: () => void;
  onStartWorkflow?: () => void;
  materialFilename?: string | null;
  dimensionCount?: number;
  hasGuidance?: boolean;
  inputsReady?: boolean;
}

function RibbonBody(props: BodyProps) {
  const { activeTab } = props;
  return (
    <div className="ribbon-body">
      {activeTab === 'home' && <HomeBody {...props} />}
      {activeTab === 'inputs' && <InputsBody {...props} />}
      {activeTab === 'run' && <RunBody />}
      {(activeTab === 'settings' || activeTab === 'tweaks') && (
        <EmptyBody label={activeTab.toUpperCase()} />
      )}
    </div>
  );
}

// Per handoff §4.3.3: Home = two button clusters separated by a 2px line.
// Right cluster is stage-specific; Start is enabled only when inputs are
// ready (step 7a).
function HomeBody({
  stage,
  onStartWorkflow,
  inputsReady,
}: BodyProps) {
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
          <button
            className="btn primary"
            onClick={onStartWorkflow}
            disabled={!inputsReady || !onStartWorkflow}
            title={!inputsReady ? '先載入 material + dimensions' : undefined}
          >
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

// Per handoff §4.3.3: three input slots. Step 7a: wired to IPC pickers
// + status from the store. Slot shows filename when loaded.
function InputsBody({
  onPickMaterial,
  onPickDimensions,
  onPickGuidance,
  onClearGuidance,
  materialFilename,
  dimensionCount = 0,
  hasGuidance = false,
}: BodyProps) {
  return (
    <div className="inputs-body">
      <InputSlot
        label="MATERIAL"
        required
        loadedText={materialFilename ?? null}
        emptyHint="選擇 .md / .txt · 必填"
        onPick={onPickMaterial}
      />
      <InputSlot
        label="DIMENSIONS"
        required
        loadedText={dimensionCount > 0 ? `${dimensionCount} 維度` : null}
        emptyHint="選擇 .yaml · 必填"
        onPick={onPickDimensions}
      />
      <InputSlot
        label="GUIDANCE"
        loadedText={hasGuidance ? '已載入' : null}
        emptyHint="選擇 .md · 強建議"
        onPick={onPickGuidance}
        onClear={hasGuidance ? onClearGuidance : undefined}
      />
    </div>
  );
}

interface InputSlotProps {
  label: string;
  emptyHint: string;
  loadedText: string | null;
  required?: boolean;
  onPick?: () => void;
  onClear?: () => void;
}

function InputSlot({ label, emptyHint, loadedText, required, onPick, onClear }: InputSlotProps) {
  const loaded = !!loadedText;
  return (
    <div
      className={`slot-placeholder ${loaded ? 'loaded' : ''} ${required ? '' : 'optional'}`}
      onClick={onPick}
      role="button"
      tabIndex={0}
    >
      <span className="ulms-label">{label}</span>
      <span className="ulms-meta">{loadedText ?? emptyHint}</span>
      {onClear && (
        <button
          className="btn xs ghost"
          style={{ alignSelf: 'flex-start', marginTop: 2 }}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          清除
        </button>
      )}
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
