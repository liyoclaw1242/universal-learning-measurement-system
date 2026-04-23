// ULMS formal v1 — shell assembly after Step 5.1–5.8
// Components now live in @ulms/ui. Shell is responsible for composition,
// state (local useState now, Zustand in step 6), and IPC wiring (step 7).

import { useState, useMemo } from 'react';
import {
  Ribbon,
  StatusBar,
  NavRail,
  TabBar,
  OverviewTab,
  ItemDetailTab,
  TerminalTab,
  type RibbonTab,
  type Tab,
  type AgentId,
  type Density,
  type Stage,
} from '@ulms/ui';
import {
  session as fxSession,
  agents as fxAgents,
  items as fxItems,
  dimensions as fxDimensions,
  streamLog as fxStreamLog,
  itemChecks as fxItemChecks,
  itemCode as fxItemCode,
  itemOptions as fxItemOptions,
  sourceExcerpt as fxSourceExcerpt,
} from '@ulms/ui/fixtures';

type CenterTabId = 'overview' | `item_${string}` | `term-${AgentId}` | 'term-unified';

export default function App() {
  const [stage, setStage] = useState<Stage>('review');
  const [density, setDensity] = useState<Density>('standard');
  const [ribbonTab, setRibbonTab] = useState<RibbonTab>('home');
  const [selectedItemId, setSelectedItemId] = useState<string>('item_003');
  const [activeAgentId, setActiveAgentId] = useState<AgentId>('agent-2');
  const [activeCenterTab, setActiveCenterTab] = useState<CenterTabId>('overview');
  const [openTabIds, setOpenTabIds] = useState<CenterTabId[]>(['overview', 'item_003']);

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

  const openTab = (id: CenterTabId) => {
    setOpenTabIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveCenterTab(id);
  };
  const closeTab = (id: CenterTabId) => {
    if (id === 'overview') return;
    setOpenTabIds((prev) => {
      const next = prev.filter((x) => x !== id);
      if (activeCenterTab === id) {
        const fallback = next[next.length - 1] ?? 'overview';
        setActiveCenterTab(fallback as CenterTabId);
      }
      return next;
    });
  };

  const handleSelectItem = (id: string) => {
    setSelectedItemId(id);
    openTab(`item_${id.replace('item_', '')}` as CenterTabId);
  };
  const handleSelectAgent = (id: AgentId) => {
    setActiveAgentId(id);
    openTab(`term-${id}`);
  };

  const displaySession = { ...fxSession, status: stageToStatus(stage) };

  return (
    <div className="shell ulms-root" data-density={density}>
      <Ribbon
        session={displaySession}
        stage={stage}
        activeTab={ribbonTab}
        density={density}
        onTabChange={setRibbonTab}
        onDensityChange={setDensity}
        onRunSecondOpinion={() => console.log('gemini second opinion (not wired)')}
        onExport={() => console.log('export (not wired)')}
      />

      <NavRail
        stage={stage}
        items={fxItems}
        selectedItemId={selectedItemId}
        onSelectItem={handleSelectItem}
        agents={fxAgents}
        activeAgentId={activeAgentId}
        onSelectAgent={handleSelectAgent}
      />

      <section className="center" aria-label="main workspace">
        <TabBar
          tabs={centerTabs}
          activeTabId={activeCenterTab}
          onActivate={(id) => setActiveCenterTab(id as CenterTabId)}
          onClose={(id) => closeTab(id as CenterTabId)}
          onAdd={() => openTab('term-unified')}
        />
        <div className="tab-body">{renderTabBody(activeCenterTab, { selectedItemId })}</div>
      </section>

      <StatusBar
        session={displaySession}
        stage={stage}
        onToggleStage={(next) => setStage(next)}
        versionLabel="ULMS · v0.1 step-5"
      />
    </div>
  );
}

function stageToStatus(s: Stage) {
  if (s === 'running') return 'running' as const;
  if (s === 'review') return 'review' as const;
  return 'idle' as const;
}

function renderTabBody(activeId: CenterTabId, ctx: { selectedItemId: string }) {
  if (activeId === 'overview') {
    return <OverviewTab items={fxItems} dimensions={fxDimensions} />;
  }
  if (activeId.startsWith('item_')) {
    const item = fxItems.find((i) => i.id === activeId) ?? fxItems.find((i) => i.id === ctx.selectedItemId);
    if (!item) return <EmptyBody label={activeId} />;
    return (
      <ItemDetailTab
        item={item}
        options={fxItemOptions[item.id]}
        checks={fxItemChecks[item.id]}
        sourceExcerpt={fxSourceExcerpt[item.id]}
        stemCode={fxItemCode[item.id]}
      />
    );
  }
  if (activeId === 'term-unified') {
    return <TerminalTab agentId="unified" streamLog={fxStreamLog} />;
  }
  if (activeId.startsWith('term-')) {
    const aid = activeId.replace('term-', '') as AgentId;
    return <TerminalTab agentId={aid} streamLog={fxStreamLog} />;
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
