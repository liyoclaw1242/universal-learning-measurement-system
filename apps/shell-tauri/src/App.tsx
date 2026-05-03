// ULMS formal v1 — shell after Step 7a.
// Inputs + workflow are now wired through the Electron IPC bridge; the
// Zustand store holds live state updated by coordinator events.

import { useEffect, useMemo, useState } from 'react';
import {
  Ribbon,
  StatusBar,
  NavRail,
  ModeBar,
  TabBar,
  OverviewTab,
  ItemDetailTab,
  TerminalTab,
  TranslationPanel,
  DimensionsEditor,
  PdfReader,
  HomeView as UiHomeView,
  WarningsTray,
  type AgentId,
  type CompetencyDimension,
  type Mode,
  type Tab,
  type UserOverride,
} from '@ulms/ui';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShellStore } from '@/state/shellStore';
import { bridge, type LearnSessionMeta, type McpSetup, type RunMeta } from '@/state/ipcBridge';
import WikiTab from '@/components/WikiTab';

export default function App() {
  const mode = useShellStore((s) => s.mode);
  const setMode = useShellStore((s) => s.setMode);
  const stage = useShellStore((s) => s.stage);
  const density = useShellStore((s) => s.density);
  const activeRibbonTab = useShellStore((s) => s.activeRibbonTab);
  const activeCenterTab = useShellStore((s) => s.activeCenterTab);
  const openTabIds = useShellStore((s) => s.openTabIds);
  const selectedItemId = useShellStore((s) => s.selectedItemId);
  const activeAgentId = useShellStore((s) => s.activeAgentId);

  const session = useShellStore((s) => s.session);
  const items = useShellStore((s) => s.items);
  const agents = useShellStore((s) => s.agents);
  const streamLog = useShellStore((s) => s.streamLog);
  const dimensions = useShellStore((s) => s.dimensions);
  const itemChecks = useShellStore((s) => s.itemChecks);
  const itemCode = useShellStore((s) => s.itemCode);
  const itemOptions = useShellStore((s) => s.itemOptions);
  const sourceExcerpt = useShellStore((s) => s.sourceExcerpt);

  const inputsReady = useShellStore((s) => s.inputsReady);
  const loadedMaterialFilename = useShellStore((s) => s.loadedMaterialFilename);
  const loadedMaterialSourceCount = useShellStore((s) => s.loadedMaterialSourceCount);
  const loadedDimensionCount = useShellStore((s) => s.loadedDimensionCount);
  const loadedGuidance = useShellStore((s) => s.loadedGuidance);
  const geminiRunning = useShellStore((s) => s.geminiRunning);
  const geminiStartedAt = useShellStore((s) => s.geminiStartedAt);
  const reviewSummary = useShellStore((s) => s.reviewSummary);
  const warnings = useShellStore((s) => s.warnings);
  const dismissWarning = useShellStore((s) => s.dismissWarning);
  const dismissAllWarnings = useShellStore((s) => s.dismissAllWarnings);
  const regeneratingItemId = useShellStore((s) => s.regeneratingItemId);
  const regenerateBatchRemaining = useShellStore((s) => s.regenerateBatchRemaining);
  const learn = useShellStore((s) => s.learn);
  const [generatingDimensions, setGeneratingDimensions] = useState(false);

  // Derived: count of items user has rejected.
  const rejectedCount = useMemo(() => items.filter((i) => i.user === 'reject').length, [items]);

  const setDensity = useShellStore((s) => s.setDensity);
  const setRibbonTab = useShellStore((s) => s.setRibbonTab);
  const setActiveCenterTab = useShellStore((s) => s.setActiveCenterTab);
  const setStage = useShellStore((s) => s.setStage);
  const openTab = useShellStore((s) => s.openTab);
  const closeTab = useShellStore((s) => s.closeTab);
  const selectItem = useShellStore((s) => s.selectItem);
  const selectAgent = useShellStore((s) => s.selectAgent);
  const applyItemOverride = useShellStore((s) => s.applyItemOverride);

  const centerTabs: Tab[] = useMemo(() => {
    return openTabIds.map<Tab>((id) => {
      if (id === 'overview') return { id, label: 'Overview' };
      if (id === 'learn') return { id, label: 'Learn', glyph: 'cog', closable: true };
      if (id === 'dimensions-editor') return { id, label: 'Dimensions', glyph: 'cog', closable: true };
      if (id === 'term-unified') return { id, label: 'unified', glyph: 'cog', closable: true };
      if (id === 'term-gemini') return { id, label: 'gemini', glyph: 'cog', closable: true };
      if (id.startsWith('term-')) {
        const aid = id.replace('term-', '') as AgentId;
        return { id, label: aid, glyph: 'cog', closable: true };
      }
      return { id, label: id, closable: true };
    });
  }, [openTabIds]);

  // Tick elapsed seconds while Gemini is running. 500ms cadence is
  // enough for the ribbon counter; we throw away the timer when idle.
  const [geminiElapsedS, setGeminiElapsedS] = useState(0);
  useEffect(() => {
    if (!geminiRunning || !geminiStartedAt) {
      setGeminiElapsedS(0);
      return;
    }
    const id = window.setInterval(() => {
      setGeminiElapsedS((Date.now() - geminiStartedAt) / 1000);
    }, 500);
    return () => window.clearInterval(id);
  }, [geminiRunning, geminiStartedAt]);

  // Auto-open term-gemini tab on gemini start so the user can watch
  // its log. Closes are user-controlled.
  const openTabAction = useShellStore((s) => s.openTab);
  useEffect(() => {
    if (geminiRunning) openTabAction('term-gemini');
  }, [geminiRunning, openTabAction]);

  // Auto-open Learn tab when a paper window is opened so the side
  // panel for translations is immediately visible (Quiz mode only —
  // Learn mode renders the split inline).
  useEffect(() => {
    if (mode === 'quiz' && learn.sessionId) openTabAction('learn');
  }, [mode, learn.sessionId, openTabAction]);

  // Auto-switch to Learn mode the moment a paper session is started
  // (the user clicked Open paper from a NavRail in any mode).
  useEffect(() => {
    if (learn.sessionId && mode !== 'learn') setMode('learn');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [learn.sessionId]);

  return (
    <div className="app-root">
      <ModeBar
        mode={mode}
        onModeChange={setMode}
        learnHasSession={!!learn.sessionId}
        quizRunning={session.status === 'running'}
      />

      {mode === 'home' && <HomeView setMode={setMode} learnHasSession={!!learn.sessionId} />}

      {mode === 'wiki' && (
        <div className="wiki-shell ulms-root" data-density={density}>
          <WikiTab />
          <StatusBar
            session={session}
            stage={stage}
            onToggleStage={setStage}
            versionLabel="ULMS · v0.2 modes"
          />
        </div>
      )}

      {mode === 'learn' && (
        <div className="learn-shell ulms-root" data-density={density}>
          <NavRail
            stage="inputs"
            items={[]}
            agents={agents}
            activeAgentId={activeAgentId}
            learnSession={
              learn.sessionId
                ? {
                    id: learn.sessionId,
                    sourceUrl: learn.sourceUrl ?? '',
                    captureCount: learn.captures.length,
                    streaming: learn.streaming,
                  }
                : null
            }
            onOpenPaper={(url) =>
              void bridge.startPaperSession(url).catch((e) => alert(`Start paper failed: ${e}`))
            }
          />
          <section className="center" aria-label="main workspace">
            <div className="tab-body">
              <LearnSplit learn={learn} />
            </div>
          </section>
          <StatusBar
            session={session}
            stage={stage}
            onToggleStage={setStage}
            versionLabel="ULMS · v0.2 modes"
          />
        </div>
      )}

      {mode === 'quiz' && (
        <div className="shell ulms-root" data-density={density}>
          <Ribbon
            session={session}
            stage={stage}
            activeTab={activeRibbonTab}
            density={density}
            onTabChange={setRibbonTab}
            onDensityChange={setDensity}
            onRunSecondOpinion={
              stage === 'review' && !geminiRunning
                ? () => void bridge.startSecondOpinion()
                : undefined
            }
            onExport={async () => {
              const res = await bridge.exportItems();
              if (!res.ok && res.error && res.error !== 'canceled') {
                alert(`Export failed: ${res.error}`);
              } else if (res.ok && res.paths) {
                console.log('exported →', res.paths);
              }
            }}
            onPickMaterial={() => void bridge.pickMaterial()}
            onPickDimensions={() => void bridge.pickDimensions()}
            onGenerateDimensions={async () => {
              setGeneratingDimensions(true);
              try {
                const count = await bridge.generateDimensions();
                console.log(`generated ${count} dimensions`);
              } catch (e) {
                alert(`Generate failed: ${e}`);
              } finally {
                setGeneratingDimensions(false);
              }
            }}
            generatingDimensions={generatingDimensions}
            onEditDimensions={() => openTab('dimensions-editor')}
            onPickGuidance={() => void bridge.pickGuidance()}
            onClearGuidance={() => void bridge.clearGuidance()}
            onStartWorkflow={() => void bridge.startWorkflow()}
            materialFilename={loadedMaterialFilename}
            materialSourceCount={loadedMaterialSourceCount}
            dimensionCount={loadedDimensionCount}
            hasGuidance={loadedGuidance}
            inputsReady={inputsReady}
            geminiRunning={geminiRunning}
            geminiElapsedS={geminiElapsedS}
            reviewSummary={reviewSummary}
            rejectedCount={rejectedCount}
            onRerunRejected={
              rejectedCount > 0 && regenerateBatchRemaining === 0
                ? () => void bridge.regenerateRejected()
                : undefined
            }
            rerunBatchRemaining={regenerateBatchRemaining}
          />

          <NavRail
            stage={stage}
            items={items}
            selectedItemId={selectedItemId}
            onSelectItem={selectItem}
            agents={agents}
            activeAgentId={activeAgentId}
            onSelectAgent={selectAgent}
          />

          <section className="center" aria-label="main workspace">
            <TabBar
              tabs={centerTabs}
              activeTabId={activeCenterTab}
              onActivate={setActiveCenterTab}
              onClose={closeTab}
              onAdd={() => openTab('term-unified')}
            />
            <div className="tab-body">
              {renderTabBody(activeCenterTab, {
                selectedItemId,
                items,
                dimensions,
                itemChecks,
                itemCode,
                itemOptions,
                sourceExcerpt,
                streamLog,
                applyItemOverride,
                regeneratingItemId,
                learn,
              })}
            </div>
          </section>

          <StatusBar
            session={session}
            stage={stage}
            onToggleStage={setStage}
            versionLabel="ULMS · v0.2 modes"
          />
        </div>
      )}

      <WarningsTray
        warnings={warnings}
        max={3}
        onDismiss={dismissWarning}
        onDismissAll={dismissAllWarnings}
      />
    </div>
  );
}

interface HomeShellProps {
  setMode: (m: Mode) => void;
  learnHasSession: boolean;
}

/**
 * Thin Tauri-side shell around the @ulms/ui HomeView. Owns all state
 * + bridge invocations; pure rendering happens in HomeView.
 */
function HomeView({ setMode, learnHasSession }: HomeShellProps) {
  const [sessions, setSessions] = useState<LearnSessionMeta[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthResult, setSynthResult] = useState<{
    written: number;
    skipped: string[];
    wikiDir: string;
  } | null>(null);
  const [mcpSetup, setMcpSetup] = useState<McpSetup | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [mcpCopied, setMcpCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([bridge.listLearnSessions(), bridge.listRuns()])
      .then(([s, r]) => {
        if (cancelled) return;
        setSessions(s);
        setRuns(r);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mcpOpen || mcpSetup) return;
    bridge
      .getMcpSetup()
      .then(setMcpSetup)
      .catch(() => {});
  }, [mcpOpen, mcpSetup]);

  const importableCount = sessions.filter((s) => s.captureCount > 0).length;

  return (
    <UiHomeView
      learnHasSession={learnHasSession}
      learnSessions={sessions}
      runs={runs}
      loadError={loadError}
      importableCount={importableCount}
      synthResult={synthResult}
      isSynthesizing={synthesizing}
      mcpSetup={mcpSetup}
      isMcpOpen={mcpOpen}
      isMcpCopied={mcpCopied}
      onModeChange={setMode}
      onResumeLearnSession={async (id) => {
        try {
          await bridge.resumeLearnSession(id);
          setMode('learn');
        } catch (e) {
          alert(`Resume failed: ${e}`);
        }
      }}
      onDeleteLearnSession={async (id, label) => {
        if (
          !confirm(
            `Delete session "${label}"? PDF + page captures + notes.md will be removed.`,
          )
        ) {
          return;
        }
        try {
          await bridge.deleteLearnSession(id);
          setSessions((prev) => prev.filter((s) => s.id !== id));
        } catch (e) {
          alert(`Delete failed: ${e}`);
        }
      }}
      onDeleteRun={async (id, label) => {
        if (!confirm(`Delete run "${label}"? Snapshot files will be removed.`)) return;
        try {
          await bridge.deleteRun(id);
          setRuns((prev) => prev.filter((r) => r.id !== id));
        } catch (e) {
          alert(`Delete failed: ${e}`);
        }
      }}
      onImportAll={async () => {
        const ids = sessions.filter((s) => s.captureCount > 0).map((s) => s.id);
        if (ids.length === 0) {
          alert('No translated pages to import yet.');
          return;
        }
        try {
          await bridge.importSessionsAsMaterial(ids);
          setMode('quiz');
        } catch (e) {
          alert(`Import failed: ${e}`);
        }
      }}
      onSynthesizeWiki={async () => {
        setSynthesizing(true);
        setSynthResult(null);
        try {
          const r = await bridge.synthesizeWiki();
          setSynthResult({
            written: r.conceptsWritten,
            skipped: r.skippedHumanEdited,
            wikiDir: r.wikiDir,
          });
        } catch (e) {
          alert(`Synthesize failed: ${e}`);
        } finally {
          setSynthesizing(false);
        }
      }}
      onMcpToggleOpen={setMcpOpen}
      onMcpCopy={async (snippet) => {
        try {
          await navigator.clipboard.writeText(snippet);
          setMcpCopied(true);
          setTimeout(() => setMcpCopied(false), 1500);
        } catch {
          // Fallback if clipboard API blocked
        }
      }}
    />
  );
}


function renderTabBody(
  activeId: string,
  ctx: {
    selectedItemId: string | null;
    items: ReturnType<typeof useShellStore.getState>['items'];
    dimensions: ReturnType<typeof useShellStore.getState>['dimensions'];
    itemChecks: ReturnType<typeof useShellStore.getState>['itemChecks'];
    itemCode: ReturnType<typeof useShellStore.getState>['itemCode'];
    itemOptions: ReturnType<typeof useShellStore.getState>['itemOptions'];
    sourceExcerpt: ReturnType<typeof useShellStore.getState>['sourceExcerpt'];
    streamLog: ReturnType<typeof useShellStore.getState>['streamLog'];
    applyItemOverride: (itemId: string, override: UserOverride) => void;
    regeneratingItemId: ReturnType<typeof useShellStore.getState>['regeneratingItemId'];
    learn: ReturnType<typeof useShellStore.getState>['learn'];
  },
) {
  if (activeId === 'learn') {
    return <LearnSplit learn={ctx.learn} />;
  }
  if (activeId === 'dimensions-editor') {
    return <DimensionsEditorTab />;
  }
  if (activeId === 'overview') {
    if (ctx.items.length === 0) {
      return (
        <div style={{ padding: 24 }}>
          <p className="ulms-meta">
            (no run has produced items yet — load material + dimensions, click Start)
          </p>
        </div>
      );
    }
    return <OverviewTab items={ctx.items} dimensions={ctx.dimensions} />;
  }
  if (activeId.startsWith('item_')) {
    const item =
      ctx.items.find((i) => i.id === activeId) ??
      (ctx.selectedItemId ? ctx.items.find((i) => i.id === ctx.selectedItemId) : undefined);
    if (!item) return <EmptyBody label={activeId} />;
    return (
      <ItemDetailTab
        item={item}
        options={ctx.itemOptions[item.id]}
        checks={ctx.itemChecks[item.id]}
        sourceExcerpt={ctx.sourceExcerpt[item.id]}
        stemCode={ctx.itemCode[item.id]}
        onFlag={(id) => {
          ctx.applyItemOverride(id, 'flag');
          void bridge.applyItemOverride(id, 'flag');
        }}
        onReject={(id) => {
          ctx.applyItemOverride(id, 'reject');
          void bridge.applyItemOverride(id, 'reject');
        }}
        onPromote={(id) => {
          ctx.applyItemOverride(id, 'promote');
          void bridge.applyItemOverride(id, 'promote');
        }}
        onShip={(id) => {
          ctx.applyItemOverride(id, 'ship');
          void bridge.applyItemOverride(id, 'ship');
        }}
        onRegenerate={(id) => void bridge.regenerateItem(id)}
        regenerating={ctx.regeneratingItemId === item.id}
      />
    );
  }
  if (activeId === 'term-unified') {
    return <TerminalTab agentId="unified" streamLog={ctx.streamLog} />;
  }
  if (activeId === 'term-gemini') {
    return <TerminalTab agentId="gemini" streamLog={ctx.streamLog} />;
  }
  if (activeId.startsWith('term-')) {
    const aid = activeId.replace('term-', '') as AgentId;
    return <TerminalTab agentId={aid} streamLog={ctx.streamLog} />;
  }
  return <EmptyBody label={activeId} />;
}

function EmptyBody({ label }: { label: string }) {
  return (
    <div style={{ padding: 20 }}>
      <p className="ulms-meta">(no body registered for {label})</p>
    </div>
  );
}

interface LearnSplitProps {
  learn: ReturnType<typeof useShellStore.getState>['learn'];
}

function DimensionsEditorTab() {
  const closeTab = useShellStore((s) => s.closeTab);
  const setActiveCenterTab = useShellStore((s) => s.setActiveCenterTab);
  const [initial, setInitial] = useState<CompetencyDimension[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bridge
      .getDimensions()
      .then((d) => {
        if (!cancelled) setInitial(d);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const close = () => {
    setActiveCenterTab('overview');
    closeTab('dimensions-editor');
  };

  if (loadError) {
    return <div style={{ padding: 24 }}>load failed: {loadError}</div>;
  }
  if (!initial) {
    return <div style={{ padding: 24 }} className="ulms-meta">loading dimensions…</div>;
  }
  if (initial.length === 0) {
    return (
      <div style={{ padding: 24 }} className="ulms-meta">
        No dimensions staged yet. Use Auto or Pick in the ribbon first.
      </div>
    );
  }
  return (
    <DimensionsEditor
      initial={initial}
      onCancel={close}
      onSave={async (dims) => {
        await bridge.updateDimensions(dims);
        close();
      }}
    />
  );
}

function LearnSplit({ learn }: LearnSplitProps) {
  const setCurrentPage = useShellStore((s) => s._setLearnCurrentPage);
  const setTotalPages = useShellStore((s) => s._setLearnTotalPages);
  const pdfUrl = useMemo(
    () => (learn.pdfPath ? convertFileSrc(learn.pdfPath) : null),
    [learn.pdfPath],
  );
  const translatedPages = useMemo(
    () => new Set(learn.captures.filter((c) => c.text.length > 0).map((c) => c.index)),
    [learn.captures],
  );
  return (
    <div className="learn-split">
      <PdfReader
        pdfUrl={pdfUrl}
        currentPage={learn.currentPage}
        isStreaming={learn.streaming}
        translatedPages={translatedPages}
        onCurrentPageChange={setCurrentPage}
        onTotalPagesChange={setTotalPages}
        onTranslatePage={(pageNum, b64) => bridge.translatePage(pageNum, b64)}
      />
      <TranslationPanel
        sourceUrl={learn.sourceUrl}
        currentPage={learn.currentPage}
        totalPages={learn.totalPages}
        streaming={learn.streaming}
        captures={learn.captures}
        imported={learn.imported}
        onStop={() => void bridge.stopTranslation()}
        onImport={() =>
          void bridge.importTranslationAsMaterial().catch((e) =>
            alert(`Import failed: ${e}`),
          )
        }
        onNextPage={() => setCurrentPage(Math.min(learn.totalPages, learn.currentPage + 1))}
      />
    </div>
  );
}
