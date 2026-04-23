// ULMS formal v1 — shell
// Step 5.1 lands the Ribbon component. Other regions still placeholders
// until their own steps (5.2 StatusBar, 5.3 NavRail, 5.4 TabBar, etc.).
//
// Local React state is the working-floor for step 5.* prototypes; Zustand
// store arrives in step 6 and replaces this.

import { useState } from 'react';
import Ribbon, { type RibbonTab } from '@/components/Ribbon';
import type { Session, Stage, Density } from '@/types/session';

// Placeholder session data for static review. Step 7 replaces with IPC.
const PLACEHOLDER_SESSION: Session = {
  id: '—',
  project: '—',
  material: '—',
  elapsed_s: 0,
  cost_usd: 0,
  cost_cap: 1.0,
  status: 'idle',
};

export default function App() {
  const [stage, setStage] = useState<Stage>('inputs');
  const [density, setDensity] = useState<Density>('standard');
  const [activeRibbonTab, setActiveRibbonTab] = useState<RibbonTab>('home');

  return (
    <div className="shell ulms-root" data-density={density}>
      <Ribbon
        session={PLACEHOLDER_SESSION}
        stage={stage}
        activeTab={activeRibbonTab}
        density={density}
        onTabChange={setActiveRibbonTab}
        onDensityChange={setDensity}
      />

      {/* ───── left rail (step 5.3 / 5.8) ───── */}
      <aside className="rail" aria-label="navigation rail">
        <div className="rail-head">
          <span className="ulms-label">OUTLINE</span>
          <span className="count">—</span>
        </div>
        <div className="rail-scroll" />
      </aside>

      {/* ───── center (step 5.4 / tab bodies in 5.5–5.7) ───── */}
      <section className="center" aria-label="main workspace">
        <div className="tabbar">
          <div className="tab active">Overview</div>
        </div>
        <div className="tab-body" style={{ padding: '20px' }}>
          <p className="ulms-meta">
            (shell step 5.1 — Ribbon landed · stage=<code>{stage}</code> · density=
            <code>{density}</code>)
          </p>
          <p className="ulms-meta">
            Try Home / Inputs / Run tabs on the ribbon to see different bodies. Density toggle is on
            the right of the ribbon-tabs row. Stage buttons below switch the right-side ribbon
            actions.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn" onClick={() => setStage('inputs')}>
              stage: inputs
            </button>
            <button className="btn" onClick={() => setStage('running')}>
              stage: running
            </button>
            <button className="btn" onClick={() => setStage('review')}>
              stage: review
            </button>
          </div>
        </div>
      </section>

      {/* ───── status bar (step 5.2) ───── */}
      <div className="statusbar">
        <span className="item">
          <span className={`dot ${stage === 'running' ? 'yellow' : 'green'}`} />
          {stage === 'running' ? 'running' : stage === 'review' ? 'ready' : 'awaiting inputs'}
        </span>
        <span className="item">session —</span>
        <span className="item truncable">— material —</span>
        <span className="spacer" />
        <span className="item">ULMS · v0.1 step-5.1</span>
      </div>
    </div>
  );
}
