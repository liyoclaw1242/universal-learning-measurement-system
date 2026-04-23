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
  WarningsTray,
  type AgentId,
  type Tab,
} from '@ulms/ui';
import { useShellStore } from '@/state/shellStore';
import { bridge } from '@/state/ipcBridge';

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
  const loadedDimensionCount = useShellStore((s) => s.loadedDimensionCount);
  const loadedGuidance = useShellStore((s) => s.loadedGuidance);
  const geminiRunning = useShellStore((s) => s.geminiRunning);
  const geminiStartedAt = useShellStore((s) => s.geminiStartedAt);
  const reviewSummary = useShellStore((s) => s.reviewSummary);
  const warnings = useShellStore((s) => s.warnings);
  const dismissWarning = useShellStore((s) => s.dismissWarning);
  const dismissAllWarnings = useShellStore((s) => s.dismissAllWarnings);

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
        dimensionCount={loadedDimensionCount}
        hasGuidance={loadedGuidance}
        inputsReady={inputsReady}
        geminiRunning={geminiRunning}
        geminiElapsedS={geminiElapsedS}
        reviewSummary={reviewSummary}
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
          })}
        </div>
      </section>

      <StatusBar
        session={session}
        stage={stage}
        onToggleStage={setStage}
        versionLabel="ULMS · v0.1 step-7c"
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
    applyItemOverride: ReturnType<typeof useShellStore.getState>['applyItemOverride'];
  },
) {
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
