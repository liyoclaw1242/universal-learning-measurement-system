// Wiki maintainer — minimal UI.
// Renders a live log + status pane + manual triggers. The heavy
// lifting (claude session, poll loop, ingest dispatch) lives entirely
// in the Rust backend; the renderer just observes.

import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Activity, Play, RotateCw, Sparkles } from 'lucide-react';

interface MaintainerStatus {
  wikiDir: string;
  sessionState: 'idle' | 'spawning' | 'ingesting' | 'linting' | 'restarting' | 'error';
  model: string | null;
  tokensUsed: number;
  contextBudget: number;
  lastActivity: string | null;
  queueDepth: number;
  countsByCategory: { sources: number; concepts: number; entities: number; synthesis: number };
  lastError: string | null;
}

interface LogEntry {
  ts: string;       // local HH:MM:SS for display
  op: string;       // "ingest" | "lint" | "restart" | "info" | "error"
  message: string;
  detail?: string;
}

function defaultStatus(): MaintainerStatus {
  return {
    wikiDir: '',
    sessionState: 'idle',
    model: null,
    tokensUsed: 0,
    contextBudget: 200_000,
    lastActivity: null,
    queueDepth: 0,
    countsByCategory: { sources: 0, concepts: 0, entities: 0, synthesis: 0 },
    lastError: null,
  };
}

export default function App() {
  const [status, setStatus] = useState<MaintainerStatus>(defaultStatus);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<'ingest' | 'lint' | 'restart' | null>(null);

  // Initial fetch + polling fallback (in case events miss).
  useEffect(() => {
    void refreshStatus();
    void refreshLog();
    const id = setInterval(() => {
      void refreshStatus();
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  // Live event subscriptions.
  useEffect(() => {
    let unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const wire = async () => {
      const u1 = await listen<MaintainerStatus>('maintainer:status', (e) => {
        if (!cancelled) setStatus(e.payload);
      });
      const u2 = await listen<LogEntry>('maintainer:log', (e) => {
        if (cancelled) return;
        setLog((prev) => [...prev.slice(-199), e.payload]);
      });
      if (cancelled) {
        u1();
        u2();
      } else {
        unlisteners = [u1, u2];
      }
    };
    void wire();

    return () => {
      cancelled = true;
      for (const u of unlisteners) u();
    };
  }, []);

  async function refreshStatus() {
    try {
      const s = (await invoke('maintainer_status')) as MaintainerStatus;
      setStatus(s);
    } catch {
      // ignore — backend may not be ready yet
    }
  }

  async function refreshLog() {
    try {
      const entries = (await invoke('maintainer_recent_log', { limit: 50 })) as LogEntry[];
      setLog(entries);
    } catch {
      // ignore
    }
  }

  async function onIngest() {
    setBusy('ingest');
    try {
      await invoke('maintainer_ingest_now');
    } catch (e) {
      alert(`Ingest failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function onLint() {
    setBusy('lint');
    try {
      await invoke('maintainer_lint_now');
    } catch (e) {
      alert(`Lint failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  async function onRestart() {
    if (!confirm('Restart the claude session? Current context will be discarded.')) return;
    setBusy('restart');
    try {
      await invoke('maintainer_restart_session');
    } catch (e) {
      alert(`Restart failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  const ctxPct =
    status.contextBudget > 0 ? Math.round((status.tokensUsed / status.contextBudget) * 100) : 0;
  const ctxKind = ctxPct >= 80 ? 'bad' : ctxPct >= 60 ? 'warn' : 'ok';
  const stateKind =
    status.sessionState === 'idle'
      ? ''
      : status.sessionState === 'error'
        ? 'bad'
        : status.sessionState === 'restarting'
          ? 'warn'
          : 'busy';

  return (
    <div className="maint-shell">
      <header className="maint-hdr">
        <span className="brand">ULMS · WIKI MAINTAINER</span>
        <div className="status">
          <span>
            <span className={`dot ${stateKind}`}></span>
            <span className="label">state</span>
            <span className={`val ${stateKind || ''}`}>{status.sessionState}</span>
          </span>
          <span>
            <span className="label">ctx</span>
            <span className={`val ${ctxKind}`}>
              {ctxPct}% ({status.tokensUsed.toLocaleString()} / {status.contextBudget.toLocaleString()})
            </span>
          </span>
          <span>
            <span className="label">queue</span>
            <span className="val">{status.queueDepth}</span>
          </span>
        </div>
      </header>

      <div className="maint-body">
        <section className="maint-log" aria-label="recent activity">
          {log.length === 0 ? (
            <div className="empty">
              No log entries yet. Drop a resource into <code>raw/</code> or click{' '}
              <strong>Ingest now</strong>.
            </div>
          ) : (
            log
              .slice()
              .reverse()
              .map((e, i) => (
                <div className="entry" key={`${e.ts}-${i}`}>
                  <div className="entry-head">
                    [{e.ts}] {e.op} | {e.message}
                  </div>
                  {e.detail && <div className="entry-body">{e.detail}</div>}
                </div>
              ))
          )}
        </section>

        <aside className="maint-side">
          <h3>session</h3>
          <div className="stat-row">
            <span className="label">model</span>
            <span>{status.model ?? '—'}</span>
          </div>
          <div className="stat-row">
            <span className="label">last activity</span>
            <span>{status.lastActivity ?? '—'}</span>
          </div>
          {status.lastError && (
            <div className="stat-row" style={{ color: 'var(--ulms-red)' }}>
              <span className="label">last error</span>
              <span title={status.lastError}>
                {status.lastError.slice(0, 24)}…
              </span>
            </div>
          )}

          <h3 style={{ marginTop: 12 }}>wiki pages</h3>
          <div className="stat-row">
            <span className="label">sources</span>
            <span>{status.countsByCategory.sources}</span>
          </div>
          <div className="stat-row">
            <span className="label">concepts</span>
            <span>{status.countsByCategory.concepts}</span>
          </div>
          <div className="stat-row">
            <span className="label">entities</span>
            <span>{status.countsByCategory.entities}</span>
          </div>
          <div className="stat-row">
            <span className="label">synthesis</span>
            <span>{status.countsByCategory.synthesis}</span>
          </div>

          <div className="actions">
            <button type="button" onClick={() => void onIngest()} disabled={!!busy}>
              <Play size={11} strokeWidth={1.75} style={{ verticalAlign: -1 }} />{' '}
              {busy === 'ingest' ? 'Scanning…' : 'Ingest now'}
            </button>
            <button type="button" onClick={() => void onLint()} disabled={!!busy}>
              <Sparkles size={11} strokeWidth={1.75} style={{ verticalAlign: -1 }} />{' '}
              {busy === 'lint' ? 'Linting…' : 'Lint wiki'}
            </button>
            <button type="button" onClick={() => void onRestart()} disabled={!!busy}>
              <RotateCw size={11} strokeWidth={1.75} style={{ verticalAlign: -1 }} />{' '}
              {busy === 'restart' ? 'Restarting…' : 'Restart session'}
            </button>
          </div>
        </aside>
      </div>

      <footer className="maint-ftr">
        <span>
          <Activity size={10} strokeWidth={1.75} style={{ verticalAlign: -1 }} /> {status.wikiDir || '(wiki dir not resolved)'}
        </span>
        <span>poll: 30 min · restart at 80% ctx</span>
      </footer>
    </div>
  );
}
