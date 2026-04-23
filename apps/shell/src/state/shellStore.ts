// Zustand store for the shell's UI + data state.
// Handoff README §6 defines the target shape; we implement the UI state
// portion here + seed data from @ulms/ui/fixtures. Step 7 swaps the
// fixture seed for IPC-driven updates from the pipeline runner.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  Agent,
  AgentId,
  Density,
  Dimension,
  Item,
  ItemChecks,
  ItemOption,
  RibbonTab,
  Session,
  Stage,
  StreamLog,
  UserOverride,
} from '@ulms/ui';
import {
  agents as fxAgents,
  dimensions as fxDimensions,
  items as fxItems,
  itemChecks as fxItemChecks,
  itemCode as fxItemCode,
  itemOptions as fxItemOptions,
  session as fxSession,
  sourceExcerpt as fxSourceExcerpt,
  streamLog as fxStreamLog,
} from '@ulms/ui/fixtures';

// ─── types ──────────────────────────────────────────────

export interface ShellState {
  // UI state
  stage: Stage;
  density: Density;
  activeRibbonTab: RibbonTab;
  activeCenterTab: string;
  openTabIds: string[];

  // Selection
  selectedItemId: string | null;
  activeAgentId: AgentId;

  // Data (fixture-seeded; step 7 replaces with IPC)
  session: Session;
  items: Item[];
  agents: Agent[];
  streamLog: StreamLog;
  dimensions: Dimension[];
  itemChecks: Record<string, ItemChecks>;
  itemCode: Record<string, string>;
  itemOptions: Record<string, ItemOption[]>;
  sourceExcerpt: Record<string, string>;

  // ─── actions ───────────────────────────────────────────
  setStage: (s: Stage) => void;
  setDensity: (d: Density) => void;
  setRibbonTab: (t: RibbonTab) => void;
  setActiveCenterTab: (id: string) => void;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  selectItem: (id: string) => void;
  selectAgent: (id: AgentId) => void;
  applyItemOverride: (itemId: string, override: UserOverride) => void;
}

// Persisted subset — handoff §6: density, activeCenterTab, openTabs
// (we use openTabIds; derivation happens at render time).
type PersistedShape = Pick<ShellState, 'density' | 'activeCenterTab' | 'openTabIds'>;

// ─── store ──────────────────────────────────────────────

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      // UI defaults
      stage: 'review',
      density: 'standard',
      activeRibbonTab: 'home',
      activeCenterTab: 'overview',
      openTabIds: ['overview', 'item_003'],

      // Selection defaults
      selectedItemId: 'item_003',
      activeAgentId: 'agent-2',

      // Fixture-seeded data
      session: fxSession,
      items: fxItems,
      agents: fxAgents,
      streamLog: fxStreamLog,
      dimensions: fxDimensions,
      itemChecks: fxItemChecks,
      itemCode: fxItemCode,
      itemOptions: fxItemOptions,
      sourceExcerpt: fxSourceExcerpt,

      // Actions
      setStage: (s) => set({ stage: s }),
      setDensity: (d) => set({ density: d }),
      setRibbonTab: (t) => set({ activeRibbonTab: t }),
      setActiveCenterTab: (id) => set({ activeCenterTab: id }),

      openTab: (id) =>
        set((state) => ({
          openTabIds: state.openTabIds.includes(id) ? state.openTabIds : [...state.openTabIds, id],
          activeCenterTab: id,
        })),

      closeTab: (id) =>
        set((state) => {
          if (id === 'overview') return state;
          const next = state.openTabIds.filter((x) => x !== id);
          const nextActive =
            state.activeCenterTab === id
              ? (next[next.length - 1] ?? 'overview')
              : state.activeCenterTab;
          return { openTabIds: next, activeCenterTab: nextActive };
        }),

      selectItem: (id) =>
        set((state) => {
          const tabId = id.startsWith('item_') ? id : `item_${id}`;
          return {
            selectedItemId: id,
            openTabIds: state.openTabIds.includes(tabId)
              ? state.openTabIds
              : [...state.openTabIds, tabId],
            activeCenterTab: tabId,
          };
        }),

      selectAgent: (id) =>
        set((state) => {
          const tabId = `term-${id}`;
          return {
            activeAgentId: id,
            openTabIds: state.openTabIds.includes(tabId)
              ? state.openTabIds
              : [...state.openTabIds, tabId],
            activeCenterTab: tabId,
          };
        }),

      applyItemOverride: (itemId, override) =>
        set((state) => ({
          items: state.items.map((it) => (it.id === itemId ? { ...it, user: override } : it)),
        })),
    }),
    {
      name: 'ulms-shell-ui',
      storage: createJSONStorage(() => localStorage),
      partialize: (state): PersistedShape => ({
        density: state.density,
        activeCenterTab: state.activeCenterTab,
        openTabIds: state.openTabIds,
      }),
      version: 1,
    },
  ),
);
