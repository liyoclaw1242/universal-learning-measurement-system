// ULMS formal v1 — shell after Step 6 (Zustand).
// App.tsx composes components from @ulms/ui, reads state from
// useShellStore, and dispatches actions. Data is still fixture-seeded
// (happens inside the store); step 7 replaces the seed with IPC.

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

export default function App() {
  // Subscribe to exactly the fields this component reads. Keeps React
  // from re-rendering the whole shell on unrelated state changes.
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

  const setStage = useShellStore((s) => s.setStage);
  const setDensity = useShellStore((s) => s.setDensity);
  const setRibbonTab = useShellStore((s) => s.setRibbonTab);
  const setActiveCenterTab = useShellStore((s) => s.setActiveCenterTab);
  const openTab = useShellStore((s) => s.openTab);
  const closeTab = useShellStore((s) => s.closeTab);
  const selectItem = useShellStore((s) => s.selectItem);
  const selectAgent = useShellStore((s) => s.selectAgent);
  const applyItemOverride = useShellStore((s) => s.applyItemOverride);

  // Derive the Tab[] list for TabBar from openTabIds.
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

  // Session payload shown in chrome. Keep session.status in sync with the
  // simulated stage so the cost chip / status dot render consistently
  // until real IPC drives both.
  const displaySession = { ...session, status: stageToStatus(stage) };

  return (
    <div className="shell ulms-root" data-density={density}>
      <Ribbon
        session={displaySession}
        stage={stage}
        activeTab={activeRibbonTab}
        density={density}
        onTabChange={setRibbonTab}
        onDensityChange={setDensity}
        onRunSecondOpinion={() => console.log('gemini second opinion (step 7 wiring)')}
        onExport={() => console.log('export (step 7 wiring)')}
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
        session={displaySession}
        stage={stage}
        onToggleStage={setStage}
        versionLabel="ULMS · v0.1 step-6"
      />
    </div>
  );
}

function stageToStatus(s: ReturnType<typeof useShellStore.getState>['stage']) {
  if (s === 'running') return 'running' as const;
  if (s === 'review') return 'review' as const;
  return 'idle' as const;
}

// Tab-body router. Pure function of activeCenterTab + store data slices.
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
