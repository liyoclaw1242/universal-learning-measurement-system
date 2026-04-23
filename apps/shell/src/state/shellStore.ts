// Zustand store for the shell's UI + live pipeline state.
// Handoff README §6 defines the target shape. After step 7a the data
// slices (session / items / agents / streamLog / blackboard) are
// driven by IPC events from apps/shell/electron/coordinator, not
// fixtures. Fixtures stay in @ulms/ui for Storybook consumption.

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

// ─── static agent roster (the 4 ULMS agents) ─────────────

const AGENT_ROSTER: Agent[] = [
  { id: 'agent-1', name: 'extractor', model: 'claude-haiku-4-5', status: 'pending', cost: 0, duration_s: 0, emit: '', tools: [] },
  { id: 'agent-2', name: 'mapper', model: 'claude-haiku-4-5', status: 'pending', cost: 0, duration_s: 0, emit: '', tools: [] },
  { id: 'agent-3', name: 'designer', model: 'claude-sonnet-4-5', status: 'pending', cost: 0, duration_s: 0, emit: '', tools: [] },
  { id: 'agent-4', name: 'reviewer', model: 'claude-sonnet-4-5', status: 'pending', cost: 0, duration_s: 0, emit: '', tools: [] },
];

const PLACEHOLDER_SESSION: Session = {
  id: '—',
  project: '—',
  material: '—',
  elapsed_s: 0,
  cost_usd: 0,
  cost_cap: 1.0,
  status: 'idle',
};

// Internal coordinator ids use underscore (`agent_1`); UI types use
// dash (`agent-1`). Tiny bridge here.
function mapCoordinatorId(id: string): AgentId | null {
  if (id === 'agent_1') return 'agent-1';
  if (id === 'agent_2') return 'agent-2';
  if (id === 'agent_3') return 'agent-3';
  if (id === 'agent_4') return 'agent-4';
  return null;
}

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

  // Live data (IPC-driven after step 7a; mostly empty until workflow runs)
  session: Session;
  items: Item[];
  agents: Agent[];
  streamLog: StreamLog;
  dimensions: Dimension[];
  itemChecks: Record<string, ItemChecks>;
  itemCode: Record<string, string>;
  itemOptions: Record<string, ItemOption[]>;
  sourceExcerpt: Record<string, string>;

  /** Status of the currently-loaded inputs (returned by inputs:status IPC) */
  inputsReady: boolean;
  loadedMaterialFilename: string | null;
  loadedDimensionCount: number;
  loadedGuidance: boolean;

  /** Gemini second-opinion progress */
  geminiRunning: boolean;
  /** Merged review summary, populated after second-opinion:completed */
  reviewSummary: {
    total_items: number;
    verdict_agreement_rate: number;
    merged_verdict_counts: { accept: number; needs_revision: number; reject: number };
    disagreement_item_ids: string[];
  } | null;

  // Generic warnings surfaced from the coordinator (schema checks / raw
  // non-JSON lines / rate-limit events). Capped at 40.
  warnings: string[];

  // ─── UI actions ────────────────────────────────────────
  setStage: (s: Stage) => void;
  setDensity: (d: Density) => void;
  setRibbonTab: (t: RibbonTab) => void;
  setActiveCenterTab: (id: string) => void;
  openTab: (id: string) => void;
  closeTab: (id: string) => void;
  selectItem: (id: string) => void;
  selectAgent: (id: AgentId) => void;
  applyItemOverride: (itemId: string, override: UserOverride) => void;

  // ─── coordinator inbound (called by ipcBridge) ──────────
  _onAgentStarted: (coordinatorAgentId: string) => void;
  _onAgentCompleted: (coordinatorAgentId: string, cost: number, durationS: number) => void;
  _onAgentStreamLine: (coordinatorAgentId: string, tsISO: string, kind: string, text: string) => void;
  _onWorkflowStarted: () => void;
  _onWorkflowCompleted: () => void;
  _onWorkflowError: (msg: string) => void;
  _onInputsStatus: (status: {
    material: { filename: string; char_count: number } | null;
    dimensions: { count: number; ids: string[] } | null;
    guidance: { char_count: number } | null;
    ready: boolean;
  }) => void;
  _onTranslatedItems: (payload: {
    items: Item[];
    itemOptions: Record<string, ItemOption[]>;
    itemChecks: Record<string, ItemChecks>;
    itemCode: Record<string, string>;
  }) => void;
  _onGeminiStarted: () => void;
  _onGeminiStopped: () => void;
  _onReviewSummary: (summary: ShellState['reviewSummary']) => void;
  _pushWarning: (msg: string) => void;
}

// ─── persisted subset (unchanged from step 6) ───────────

type PersistedShape = Pick<ShellState, 'density' | 'activeCenterTab' | 'openTabIds'>;

// ─── store ──────────────────────────────────────────────

export const useShellStore = create<ShellState>()(
  persist(
    (set) => ({
      stage: 'inputs',
      density: 'standard',
      activeRibbonTab: 'home',
      activeCenterTab: 'overview',
      openTabIds: ['overview'],

      selectedItemId: null,
      activeAgentId: 'agent-1',

      session: PLACEHOLDER_SESSION,
      items: [],
      agents: AGENT_ROSTER,
      streamLog: { 'agent-1': [], 'agent-2': [], 'agent-3': [], 'agent-4': [], unified: 'merge' },
      dimensions: [],
      itemChecks: {},
      itemCode: {},
      itemOptions: {},
      sourceExcerpt: {},

      inputsReady: false,
      loadedMaterialFilename: null,
      loadedDimensionCount: 0,
      loadedGuidance: false,
      geminiRunning: false,
      reviewSummary: null,
      warnings: [],

      // ── UI actions ───────────────────────────────────

      setStage: (s) => set({ stage: s }),
      setDensity: (d) => set({ density: d }),
      setRibbonTab: (t) => set({ activeRibbonTab: t }),
      setActiveCenterTab: (id) => set({ activeCenterTab: id }),

      openTab: (id) =>
        set((st) => ({
          openTabIds: st.openTabIds.includes(id) ? st.openTabIds : [...st.openTabIds, id],
          activeCenterTab: id,
        })),

      closeTab: (id) =>
        set((st) => {
          if (id === 'overview') return st;
          const next = st.openTabIds.filter((x) => x !== id);
          const nextActive =
            st.activeCenterTab === id
              ? (next[next.length - 1] ?? 'overview')
              : st.activeCenterTab;
          return { openTabIds: next, activeCenterTab: nextActive };
        }),

      selectItem: (id) =>
        set((st) => {
          const tabId = id.startsWith('item_') ? id : `item_${id}`;
          return {
            selectedItemId: id,
            openTabIds: st.openTabIds.includes(tabId) ? st.openTabIds : [...st.openTabIds, tabId],
            activeCenterTab: tabId,
          };
        }),

      selectAgent: (id) =>
        set((st) => {
          const tabId = `term-${id}`;
          return {
            activeAgentId: id,
            openTabIds: st.openTabIds.includes(tabId) ? st.openTabIds : [...st.openTabIds, tabId],
            activeCenterTab: tabId,
          };
        }),

      applyItemOverride: (itemId, override) =>
        set((st) => ({
          items: st.items.map((it) => (it.id === itemId ? { ...it, user: override } : it)),
        })),

      // ── coordinator inbound ──────────────────────────

      _onAgentStarted: (cid) =>
        set((st) => {
          const uiId = mapCoordinatorId(cid);
          if (!uiId) return st;
          return {
            activeAgentId: uiId,
            agents: st.agents.map((a) =>
              a.id === uiId ? { ...a, status: 'active' } : a,
            ),
          };
        }),

      _onAgentCompleted: (cid, cost, durationS) =>
        set((st) => {
          const uiId = mapCoordinatorId(cid);
          if (!uiId) return st;
          const newCost = st.session.cost_usd + cost;
          return {
            agents: st.agents.map((a) =>
              a.id === uiId ? { ...a, status: 'done', cost, duration_s: durationS } : a,
            ),
            session: { ...st.session, cost_usd: newCost },
          };
        }),

      _onAgentStreamLine: (cid, ts, kind, text) =>
        set((st) => {
          const uiId = mapCoordinatorId(cid);
          if (!uiId) return st;
          const prior = st.streamLog[uiId];
          const list = Array.isArray(prior) ? prior : [];
          const k = (['thought', 'tool', 'result', 'summary', 'done', 'warn', 'error'] as const).includes(
            kind as never,
          )
            ? (kind as 'thought' | 'tool' | 'result' | 'summary' | 'done' | 'warn' | 'error')
            : 'thought';
          const nextList = [...list, { ts, kind: k, text }].slice(-500);
          return { streamLog: { ...st.streamLog, [uiId]: nextList } };
        }),

      _onWorkflowStarted: () =>
        set((st) => ({
          stage: 'running',
          warnings: [],
          session: { ...st.session, status: 'running', cost_usd: 0 },
          agents: st.agents.map((a) => ({ ...a, status: 'pending', cost: 0, duration_s: 0, tools: [] })),
          streamLog: { 'agent-1': [], 'agent-2': [], 'agent-3': [], 'agent-4': [], unified: 'merge' },
        })),

      _onWorkflowCompleted: () =>
        set((st) => ({
          stage: 'review',
          session: { ...st.session, status: 'review' },
        })),

      _onWorkflowError: (msg) =>
        set((st) => ({
          stage: 'inputs',
          session: { ...st.session, status: 'failed' },
          warnings: [...st.warnings, `workflow error: ${msg}`].slice(-40),
        })),

      _onInputsStatus: (status) =>
        set((st) => ({
          inputsReady: status.ready,
          loadedMaterialFilename: status.material?.filename ?? null,
          loadedDimensionCount: status.dimensions?.count ?? 0,
          loadedGuidance: !!status.guidance,
          session: {
            ...st.session,
            material: status.material?.filename ?? '—',
          },
        })),

      _pushWarning: (msg) => set((st) => ({ warnings: [...st.warnings, msg].slice(-40) })),

      _onTranslatedItems: (p) =>
        set(() => ({
          items: p.items,
          itemOptions: p.itemOptions,
          itemChecks: p.itemChecks,
          itemCode: p.itemCode,
        })),

      _onGeminiStarted: () => set({ geminiRunning: true }),
      _onGeminiStopped: () => set({ geminiRunning: false }),
      _onReviewSummary: (summary) => set({ reviewSummary: summary }),
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
