// HomeView — landing page for the ULMS shell. Pure presentational;
// host owns state (sessions / runs / mcpSetup / synth result) and
// threads handlers down. No bridge / invoke imports here.

import {
  ArrowRight,
  BookMarked,
  BookOpen,
  ClipboardCheck,
  FileCode2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  ListChecks,
  Newspaper,
  Youtube,
} from 'lucide-react';
import type {
  LearnSessionMeta,
  McpSetup,
  RawResourceSummary,
  RunMeta,
} from '../../types/home';
import type { Mode } from '../../types/session';
import RecentSessionRow from '../RecentSessionRow';
import McpSetupPanel from '../McpSetupPanel';

interface SynthResult {
  written: number;
  skipped: string[];
  wikiDir: string;
}

interface HomeViewProps {
  /** for the "session in progress" hint on the Learn card */
  learnHasSession: boolean;
  learnSessions: LearnSessionMeta[];
  runs: RunMeta[];
  rawImports: RawResourceSummary[];
  loadError: string | null;

  /** number of learn sessions with at least 1 capture (drives bulk-import button) */
  importableCount: number;

  /** synthesise result banner (null = hide); cleared by caller */
  synthResult: SynthResult | null;
  isSynthesizing: boolean;

  mcpSetup: McpSetup | null;
  isMcpOpen: boolean;
  isMcpCopied: boolean;

  onModeChange: (m: Mode) => void;
  onResumeLearnSession: (id: string) => void;
  onDeleteLearnSession: (id: string, label: string) => void;
  onDeleteRun: (id: string, label: string) => void;
  onImportAll: () => void;
  onSynthesizeWiki: () => void;
  onMcpToggleOpen: (open: boolean) => void;
  onMcpCopy: (snippet: string) => void;
  onOpenRawDir: () => void;
  onDeleteRawImport: (type: string, id: string, label: string) => void;
  onActivateRawImport: (r: RawResourceSummary) => void;
}

export default function HomeView(props: HomeViewProps) {
  const {
    learnHasSession,
    learnSessions,
    runs,
    rawImports,
    loadError,
    importableCount,
    synthResult,
    isSynthesizing,
    mcpSetup,
    isMcpOpen,
    isMcpCopied,
    onModeChange,
    onResumeLearnSession,
    onDeleteLearnSession,
    onDeleteRun,
    onImportAll,
    onSynthesizeWiki,
    onMcpToggleOpen,
    onMcpCopy,
    onOpenRawDir,
    onDeleteRawImport,
    onActivateRawImport,
  } = props;

  return (
    <div className="home-shell">
      <div className="home-content">
        <h1>ULMS · Universal Learning Measurement System</h1>
        <p className="home-tagline">
          Read papers in your language, then auto-generate assessment items from them.
        </p>
        <div className="home-cards">
          <div
            className="home-card"
            role="button"
            tabIndex={0}
            onClick={() => onModeChange('learn')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onModeChange('learn');
            }}
          >
            <h3>
              <BookOpen size={18} strokeWidth={1.75} />
              Learn
            </h3>
            <p>
              Open an arxiv PDF, get a side-by-side Chinese translation per page, save as a
              study note. {learnHasSession && <strong>· session in progress</strong>}
            </p>
          </div>
          <div
            className="home-card"
            role="button"
            tabIndex={0}
            onClick={() => onModeChange('quiz')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onModeChange('quiz');
            }}
          >
            <h3>
              <ClipboardCheck size={18} strokeWidth={1.75} />
              Quiz
            </h3>
            <p>
              Stage material + competency dimensions, then run the 4-agent pipeline (extract →
              map → design → review) to produce assessment items.
            </p>
          </div>
        </div>

        <div className="home-recent">
          <div className="home-recent-head">
            <h2>Recent learn sessions</h2>
            {importableCount > 0 && (
              <button
                type="button"
                className="recent-bulk-btn"
                onClick={onImportAll}
                title="Concatenate all translated papers into a single Quiz material and switch to Quiz mode"
              >
                Import all {importableCount} as Quiz material
                <ArrowRight size={14} strokeWidth={1.75} />
              </button>
            )}
          </div>
          {loadError ? (
            <div className="empty">Failed to load: {loadError}</div>
          ) : learnSessions.length === 0 ? (
            <div className="empty">
              No translated papers yet. Click <strong>Learn</strong> above to start one.
            </div>
          ) : (
            <ul className="recent-list">
              {learnSessions.map((s) => (
                <RecentSessionRow
                  key={s.id}
                  icon={<FileText size={14} strokeWidth={1.5} />}
                  title={s.sourceUrl ?? `(no url) · ${s.id}`}
                  titleTooltip={s.sourceUrl ?? s.id}
                  meta={
                    <>
                      {s.captureCount} page{s.captureCount === 1 ? '' : 's'} ·{' '}
                      {formatRelative(s.modifiedAt)}
                    </>
                  }
                  onActivate={() => onResumeLearnSession(s.id)}
                  onDelete={() => onDeleteLearnSession(s.id, s.sourceUrl ?? s.id)}
                  deleteLabel="delete session (PDF + captures + notes)"
                />
              ))}
            </ul>
          )}
        </div>

        <div className="home-recent">
          <div className="home-recent-head">
            <h2>Recent raw imports</h2>
            <button
              type="button"
              className="recent-bulk-btn"
              onClick={onOpenRawDir}
              title="Reveal ~/.ulms-wiki/raw/ in Finder"
            >
              <FolderOpen size={14} strokeWidth={1.75} />
              Open raw bank
            </button>
          </div>
          {rawImports.length === 0 ? (
            <div className="empty">
              No imports yet. Use the <strong>ULMS Learn</strong> Chrome extension on a
              YouTube watch page or article to capture into{' '}
              <code>~/.ulms-wiki/raw/</code>.
            </div>
          ) : (
            <ul className="recent-list">
              {rawImports.map((r) => (
                <RecentSessionRow
                  key={`${r.type}/${r.id}`}
                  icon={rawTypeIcon(r.type)}
                  title={r.title || r.id}
                  titleTooltip={r.sourceUrl || r.title || r.id}
                  meta={
                    <>
                      {rawTypeLabel(r.type)}
                      {r.quizzedCount > 0 ? ` · quizzed ${r.quizzedCount}×` : ''}
                      {r.verified ? ' · verified' : ''} · {formatRelative(r.capturedAt)}
                    </>
                  }
                  onActivate={() => onActivateRawImport(r)}
                  onDelete={() => onDeleteRawImport(r.type, r.id, r.title || r.id)}
                  deleteLabel="delete raw resource (folder + meta)"
                />
              ))}
            </ul>
          )}
        </div>

        <div className="home-recent">
          <div className="home-recent-head">
            <h2>Recent quiz runs</h2>
            {runs.length > 0 && (
              <button
                type="button"
                className="recent-bulk-btn"
                onClick={onSynthesizeWiki}
                disabled={isSynthesizing}
                title={`gemini groups KUs across ${runs.length} runs into wiki concept pages (繁中)`}
                style={{
                  background: 'transparent',
                  color: 'var(--ulms-blue)',
                  borderColor: 'var(--ulms-blue)',
                }}
              >
                <BookMarked size={14} strokeWidth={1.75} />
                {isSynthesizing ? 'Synthesizing…' : 'Synthesize wiki'}
              </button>
            )}
          </div>
          {synthResult && (
            <div
              className="empty"
              style={{ color: 'var(--ulms-green)', fontStyle: 'normal' }}
            >
              ✓ Wrote {synthResult.written} concept page{synthResult.written === 1 ? '' : 's'}
              {synthResult.skipped.length > 0
                ? ` · ${synthResult.skipped.length} skipped (human-edited)`
                : ''}
              {' · '}
              <code>{synthResult.wikiDir}</code>
            </div>
          )}
          <McpSetupPanel
            setup={mcpSetup}
            isOpen={isMcpOpen}
            isCopied={isMcpCopied}
            onToggleOpen={onMcpToggleOpen}
            onCopy={onMcpCopy}
          />
          {runs.length === 0 ? (
            <div className="empty">
              No runs yet. Stage material + dimensions in <strong>Quiz</strong>, click Start,
              and each completed run is auto-archived to <code>workspace/runs/</code>.
            </div>
          ) : (
            <ul className="recent-list">
              {runs.map((r) => {
                const label = r.materialFilename ?? r.id;
                return (
                  <RecentSessionRow
                    key={r.id}
                    icon={<ListChecks size={14} strokeWidth={1.5} />}
                    title={label}
                    meta={
                      <>
                        {r.itemCount} item{r.itemCount === 1 ? '' : 's'} · {r.dimensionCount}{' '}
                        dim · ${r.totalCostUsd.toFixed(3)} · {formatRelative(r.timestamp)}
                      </>
                    }
                    onDelete={() => onDeleteRun(r.id, label)}
                    deleteLabel="delete run snapshot"
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function rawTypeIcon(type: string) {
  switch (type) {
    case 'youtube':
      return <Youtube size={14} strokeWidth={1.5} />;
    case 'article':
      return <Newspaper size={14} strokeWidth={1.5} />;
    case 'paper':
      return <FileText size={14} strokeWidth={1.5} />;
    case 'book':
      return <BookOpen size={14} strokeWidth={1.5} />;
    case 'image':
      return <ImageIcon size={14} strokeWidth={1.5} />;
    case 'markdown':
      return <FileCode2 size={14} strokeWidth={1.5} />;
    default:
      return <FileText size={14} strokeWidth={1.5} />;
  }
}

function rawTypeLabel(type: string): string {
  switch (type) {
    case 'youtube':
      return 'YouTube';
    case 'article':
      return 'Article';
    case 'paper':
      return 'Paper';
    case 'book':
      return 'Book';
    case 'image':
      return 'Image';
    case 'markdown':
      return 'Markdown';
    default:
      return type;
  }
}

function formatRelative(iso: string): string {
  if (!iso) return '—';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso.slice(0, 10);
  const diffMs = Date.now() - ts;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return iso.slice(0, 10);
}
