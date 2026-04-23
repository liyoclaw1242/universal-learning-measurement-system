// ULMS formal v1 — shell scaffolding
// Step 4 per design handoff README §11: 5-region CSS grid with placeholder
// divs. No interactivity yet; steps 5+ will wire Ribbon / NavRail / TabBar /
// tab bodies / state store.
//
// Grid (from app/src/styles/shell.css):
//   rows    36px / 32px / auto / 1fr / 22px
//   cols    260px / 1fr
//
// ┌──────────────────────────────────────────┐
// │  ribbon-strip    (36px, full-width)       │
// ├──────────────────────────────────────────┤
// │  ribbon-tabs     (32px, full-width)       │
// ├──────────────────────────────────────────┤
// │  ribbon-body     (auto, full-width)       │
// ├──────────┬───────────────────────────────┤
// │  rail    │  center (tabbar + tab-body)   │
// │  (260px) │  (1fr)                        │
// ├──────────┴───────────────────────────────┤
// │  statusbar       (22px, full-width)       │
// └──────────────────────────────────────────┘

export default function App() {
  return (
    <div className="shell ulms-root" data-density="standard">
      {/* ───── ribbon strip (session meta) ───── */}
      <div className="ribbon-strip">
        <div className="breadcrumb">
          <span className="brand">ulms</span>
          <span className="sep">›</span>
          <span>— project —</span>
          <span className="sep">›</span>
          <span className="session-id">session —</span>
        </div>
        <div className="right">
          <span className="cost-chip" data-state="ok">
            <span className="track">
              <span className="fill" style={{ width: '0%' }} />
            </span>
            <span>$0.00</span>
            <span className="total">/ $1.00</span>
          </span>
        </div>
      </div>

      {/* ───── ribbon tabs ───── */}
      <div className="ribbon-tabs">
        <div className="tab active">Home</div>
        <div className="tab">Inputs</div>
        <div className="tab">Run</div>
        <div className="tab">Settings</div>
        <div className="tab">Tweaks</div>
        <div className="spacer" />
      </div>

      {/* ───── ribbon body (contextual to active ribbon tab) ───── */}
      <div className="ribbon-body">
        <span className="ulms-label">HOME</span>
      </div>

      {/* ───── left rail ───── */}
      <aside className="rail" aria-label="navigation rail">
        <div className="rail-head">
          <span className="ulms-label">OUTLINE</span>
          <span className="count">—</span>
        </div>
        <div className="rail-scroll" />
      </aside>

      {/* ───── center (tabbar + tab body) ───── */}
      <section className="center" aria-label="main workspace">
        <div className="tabbar">
          <div className="tab active">Overview</div>
        </div>
        <div className="tab-body" style={{ padding: '20px' }}>
          <p className="ulms-meta">(shell scaffold — step 4)</p>
        </div>
      </section>

      {/* ───── status bar ───── */}
      <div className="statusbar">
        <span className="item">
          <span className="dot green" />
          ready
        </span>
        <span className="item">session —</span>
        <span className="item truncable">— material —</span>
        <span className="spacer" />
        <span className="item">ULMS · v0.1 scaffold</span>
      </div>
    </div>
  );
}
