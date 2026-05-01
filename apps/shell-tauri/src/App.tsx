import { useEffect, useRef, useState } from 'react';
import { bridge } from './bridge';

type Status = 'idle' | 'running' | 'done' | 'error';

export function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    // Tauri's listen() is async, so the unsubscribe fn arrives after the
    // promise resolves. Under React StrictMode dev double-invoke, the
    // first cleanup runs before any unsubs are pushed → duplicate
    // listeners. Track cancellation so a late-resolving listener
    // unsubscribes itself immediately.
    let cancelled = false;
    const unsubs: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      p.then((u) => {
        if (cancelled) u();
        else unsubs.push(u);
      });
    };

    track(
      bridge.onAgentStream((p) => {
        setLines((prev) => [...prev, `[${p.agent}] ${p.line}`]);
      }),
    );
    track(
      bridge.onAgentCompleted((p) => {
        setExitCode(p.exit_code);
        setStatus(p.exit_code === 0 ? 'done' : 'error');
      }),
    );
    track(
      bridge.onWorkflowError((p) => {
        setLines((prev) => [...prev, `[error] ${p.error}`]);
        setStatus('error');
      }),
    );

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const start = async () => {
    setLines([]);
    setExitCode(null);
    setStatus('running');
    try {
      await bridge.startWorkflow();
    } catch (e) {
      setLines((prev) => [...prev, `[invoke-error] ${String(e)}`]);
      setStatus('error');
    }
  };

  const stop = () => bridge.stopWorkflow();

  return (
    <div>
      <h1>ULMS — Tauri Spike</h1>
      <div className="status">
        status: <strong>{status}</strong>
        {exitCode !== null && <> · exit code: {exitCode}</>}
      </div>
      <div className="row">
        <button className="primary" onClick={start} disabled={status === 'running'}>
          Start workflow
        </button>
        <button onClick={stop} disabled={status !== 'running'}>
          Stop
        </button>
      </div>
      <pre className="log" ref={logRef}>
        {lines.length === 0 ? '(no output yet — click Start)' : lines.join('\n')}
      </pre>
    </div>
  );
}
