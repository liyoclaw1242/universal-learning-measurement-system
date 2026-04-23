// ShellFrame — Storybook helper that gives grid-dependent components
// (Ribbon / NavRail / StatusBar) their natural 5-region context without
// forcing every story to repeat the scaffold. Stories pass the slot they
// care about; other slots get placeholder fill so the grid resolves.

import type { ReactNode } from 'react';

interface ShellFrameProps {
  strip?: ReactNode;
  tabs?: ReactNode;
  body?: ReactNode;
  rail?: ReactNode;
  center?: ReactNode;
  status?: ReactNode;
  density?: 'compact' | 'standard' | 'focus';
}

/** Render a full shell grid filled in with whichever slots the caller
 *  provides, defaulting the rest to neutral placeholders. */
export default function ShellFrame({
  strip,
  tabs,
  body,
  rail,
  center,
  status,
  density = 'standard',
}: ShellFrameProps) {
  return (
    <div
      className="shell ulms-root"
      data-density={density}
      style={{ height: '100vh', width: '100vw' }}
    >
      {strip ?? (
        <div className="ribbon-strip">
          <span className="ulms-meta">(ribbon-strip placeholder)</span>
        </div>
      )}
      {tabs ?? (
        <div className="ribbon-tabs">
          <span className="ulms-meta" style={{ alignSelf: 'center', paddingLeft: 14 }}>
            (ribbon-tabs placeholder)
          </span>
        </div>
      )}
      {body ?? (
        <div className="ribbon-body">
          <span className="ulms-meta">(ribbon-body placeholder)</span>
        </div>
      )}
      {rail ?? (
        <aside className="rail">
          <div className="rail-head">
            <span className="ulms-label">(rail placeholder)</span>
          </div>
        </aside>
      )}
      {center ?? (
        <section className="center">
          <div className="tabbar">
            <div className="tab active">Overview</div>
          </div>
          <div className="tab-body" style={{ padding: 20 }}>
            <p className="ulms-meta">(center placeholder)</p>
          </div>
        </section>
      )}
      {status ?? (
        <div className="statusbar">
          <span className="item">
            <span className="dot green" />
            (status placeholder)
          </span>
        </div>
      )}
    </div>
  );
}
