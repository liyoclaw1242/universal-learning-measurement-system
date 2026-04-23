// ULMS formal v1 — shell after Step 7a.
// Inputs + workflow are now wired through the Electron IPC bridge; the
// Zustand store holds live state updated by coordinator events.

import { useMemo } from 'react';
import {
  Ribbon,
  StatusBar,
  NavRail,
  TabBar,
  OverviewTab,
  ItemDetailTab,
  TerminalTab,
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
      if (id.startsWith('term-')) {
        const aid = id.replace('term-', '') as AgentId;
        return { id, label: aid, glyph: 'cog', closable: true };
      }
      return { id, label: id, closable: true };
    });
  }, [openTabIds]);

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
        onExport={() => console.log('export (step 7b-2)')}
        onPickMaterial={() => void bridge.pickMaterial()}
        onPickDimensions={() => void bridge.pickDimensions()}
        onPickGuidance={() => void bridge.pickGuidance()}
        onClearGuidance={() => void bridge.clearGuidance()}
        onStartWorkflow={() => void bridge.startWorkflow()}
        materialFilename={loadedMaterialFilename}
        dimensionCount={loadedDimensionCount}
        hasGuidance={loadedGuidance}
        inputsReady={inputsReady}
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
        versionLabel="ULMS · v0.1 step-7b"
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
        onFlag={(id) => ctx.applyItemOverride(id, 'flag')}
        onReject={(id) => ctx.applyItemOverride(id, 'reject')}
        onPromote={(id) => ctx.applyItemOverride(id, 'promote')}
        onShip={(id) => ctx.applyItemOverride(id, 'ship')}
      />
    );
  }
  if (activeId === 'term-unified') {
    return <TerminalTab agentId="unified" streamLog={ctx.streamLog} />;
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
