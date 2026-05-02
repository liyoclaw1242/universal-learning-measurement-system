// ULMS formal v1 — shell after Step 7a.
// Inputs + workflow are now wired through the Electron IPC bridge; the
// Zustand store holds live state updated by coordinator events.

import { useEffect, useMemo, useState } from 'react';
import {
  Ribbon,
  StatusBar,
  NavRail,
  TabBar,
  OverviewTab,
  ItemDetailTab,
  TerminalTab,
  TranslationPanel,
  WarningsTray,
  type AgentId,
  type Tab,
  type UserOverride,
} from '@ulms/ui';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useShellStore } from '@/state/shellStore';
import { bridge } from '@/state/ipcBridge';
import PdfReader from '@/components/PdfReader';

export default function App() {
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
  // panel for translations is immediately visible.
  useEffect(() => {
    if (learn.sessionId) openTabAction('learn');
  }, [learn.sessionId, openTabAction]);

  return (
    <div className="shell ulms-root" data-density={density}>
      <Ribbon
        session={session}
        stage={stage}
        activeTab={activeRibbonTab}
        density={density}
        onTabChange={setRibbonTab}
        onDensityChange={setDensity}
        onRunSecondOpinion={
          stage === 'review' && !geminiRunning ? () => void bridge.startSecondOpinion() : undefined
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
        versionLabel="ULMS · v0.1 step-7d"
      />

      <WarningsTray
        warnings={warnings}
        max={3}
        onDismiss={dismissWarning}
        onDismissAll={dismissAllWarnings}
      />
    </div>
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
      />
    </div>
  );
}
