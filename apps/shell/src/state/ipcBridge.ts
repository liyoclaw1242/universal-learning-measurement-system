// Renderer-side IPC bridge: subscribes to coordinator events via
// window.ulms and dispatches store actions. Called once from main.tsx
// before App mounts; returns a cleanup fn for hot-reload.

import { useShellStore } from './shellStore';
import { translateBoard, type TranslateInput } from './translateBoard';

// Narrowing helpers for untyped IPC payloads — preload's bridge is
// intentionally `unknown` on the event side so the renderer can evolve
// independent of the coordinator's exact message shape.

interface AgentStreamMsg {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; content?: unknown }> };
  total_cost_usd?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

function nowHMS(): string {
  return new Date().toISOString().slice(11, 19); // "HH:MM:SS"
}

function formatToolInputPreview(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  if (name === 'Read' || name === 'Write') {
    return String(i.file_path ?? '');
  }
  if (name === 'Bash') {
    return String(i.command ?? '');
  }
  return JSON.stringify(i).slice(0, 120);
}

export function setupIpcBridge(): () => void {
  const { _pushWarning } = useShellStore.getState();
  const ulms = (window as unknown as { ulms?: typeof window.ulms }).ulms;
  if (!ulms) {
    console.warn('window.ulms not present — preload bridge missing');
    return () => {};
  }

  const unsubs: Array<() => void> = [];

  // ─── inputs + status ─────────────────────────────────

  void ulms.inputsStatus().then((st) => {
    useShellStore.getState()._onInputsStatus(st as never);
  });

  // ─── workflow lifecycle ──────────────────────────────

  unsubs.push(
    ulms.onWorkflowStarted(() => useShellStore.getState()._onWorkflowStarted()),
  );
  unsubs.push(
    ulms.onWorkflowCompleted(() => useShellStore.getState()._onWorkflowCompleted()),
  );
  unsubs.push(
    ulms.onWorkflowError(({ error }) => useShellStore.getState()._onWorkflowError(error)),
  );

  // ─── board updates ───────────────────────────────────

  unsubs.push(
    ulms.onBoardUpdated(({ board }) => {
      const b = board as {
        user_input?: { material?: { filename?: string; content?: string } };
        costs?: { total_usd?: number };
      } | null;
      if (!b) return;
      const state = useShellStore.getState();

      // Always refresh session cost + material filename
      useShellStore.setState({
        session: {
          ...state.session,
          cost_usd: typeof b.costs?.total_usd === 'number' ? b.costs.total_usd : state.session.cost_usd,
          material: b.user_input?.material?.filename ?? state.session.material,
        },
      });

      // Translate to UI Item[] shape (no-op until agent-3 produces items)
      const translated = translateBoard(board as TranslateInput);
      useShellStore.getState()._onTranslatedItems(translated);
    }),
  );

  // ─── agent lifecycle ─────────────────────────────────

  unsubs.push(
    ulms.onAgentStarted(({ agent }) => {
      useShellStore.getState()._onAgentStarted(agent);
      useShellStore
        .getState()
        ._onAgentStreamLine(agent, nowHMS(), 'summary', `── ${agent} starting ──`);
    }),
  );

  unsubs.push(
    ulms.onAgentCompleted((payload) => {
      const p = payload as {
        agent: string;
        exit_code: number | null;
        result: { total_cost_usd?: number; duration_ms?: number; subtype?: string } | null;
      };
      const cost = p.result?.total_cost_usd ?? 0;
      const durationS = (p.result?.duration_ms ?? 0) / 1000;
      useShellStore.getState()._onAgentCompleted(p.agent, cost, durationS);
      const line = `✔ ${p.result?.subtype ?? 'exit ' + p.exit_code} · $${cost.toFixed(4)} · ${durationS.toFixed(1)}s`;
      useShellStore.getState()._onAgentStreamLine(p.agent, nowHMS(), 'done', line);
    }),
  );

  unsubs.push(
    ulms.onAgentStream(({ agent, msg }) => {
      const m = msg as AgentStreamMsg;
      if (m.type === 'system' && m.subtype === 'init') {
        useShellStore
          .getState()
          ._onAgentStreamLine(agent, nowHMS(), 'thought', `session ${String(m.session_id).slice(0, 8)}`);
        return;
      }
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) {
            useShellStore.getState()._onAgentStreamLine(agent, nowHMS(), 'thought', block.text.slice(0, 300));
          } else if (block.type === 'tool_use' && block.name) {
            const preview = formatToolInputPreview(block.name, block.input);
            useShellStore
              .getState()
              ._onAgentStreamLine(agent, nowHMS(), 'tool', `${block.name}: ${preview}`);
          }
        }
        return;
      }
      if (m.type === 'user' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'tool_result') {
            const out =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
                  : JSON.stringify(block.content);
            const truncated = out.length > 200 ? out.slice(0, 200) + ' …' : out;
            useShellStore.getState()._onAgentStreamLine(agent, nowHMS(), 'result', truncated);
          }
        }
        return;
      }
      if (m.type === 'result') {
        // completed event handler already logs this; ignore here.
        return;
      }
    }),
  );

  unsubs.push(
    ulms.onAgentRaw(({ agent, line }) => {
      useShellStore.getState()._onAgentStreamLine(agent, nowHMS(), 'warn', line.slice(0, 200));
    }),
  );

  // ─── schema warnings ─────────────────────────────────

  unsubs.push(
    ulms.onSchemaWarn(({ agent, warnings }) => {
      for (const w of warnings) {
        _pushWarning(`[${agent}] ${w}`);
      }
    }),
  );

  // ─── Gemini second opinion ───────────────────────────

  unsubs.push(
    ulms.onGeminiStarted(() => {
      useShellStore.getState()._onGeminiStarted();
    }),
  );

  unsubs.push(
    ulms.onGeminiCompleted(() => {
      useShellStore.getState()._onGeminiStopped();
    }),
  );

  unsubs.push(
    ulms.onSecondOpinionCompleted((payload) => {
      useShellStore.getState()._onGeminiStopped();
      const p = payload as {
        merged_summary?: {
          total_items?: number;
          verdict_agreement_rate?: number;
          merged_verdict_counts?: { accept?: number; needs_revision?: number; reject?: number };
          disagreement_item_ids?: string[];
        };
      };
      const s = p.merged_summary;
      if (s) {
        useShellStore.getState()._onReviewSummary({
          total_items: s.total_items ?? 0,
          verdict_agreement_rate: s.verdict_agreement_rate ?? 0,
          merged_verdict_counts: {
            accept: s.merged_verdict_counts?.accept ?? 0,
            needs_revision: s.merged_verdict_counts?.needs_revision ?? 0,
            reject: s.merged_verdict_counts?.reject ?? 0,
          },
          disagreement_item_ids: s.disagreement_item_ids ?? [],
        });
      }
    }),
  );

  unsubs.push(
    ulms.onSecondOpinionError(({ error }) => {
      useShellStore.getState()._onGeminiStopped();
      _pushWarning(`[gemini] ${error}`);
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}

// ─── imperative bridge helpers for components ────────

export const bridge = {
  async refreshInputsStatus(): Promise<void> {
    const ulms = (window as unknown as { ulms?: typeof window.ulms }).ulms;
    if (!ulms) return;
    const status = await ulms.inputsStatus();
    useShellStore.getState()._onInputsStatus(status as never);
  },
  async pickMaterial(): Promise<void> {
    await window.ulms.pickMaterial();
    await this.refreshInputsStatus();
  },
  async pickDimensions(): Promise<void> {
    await window.ulms.pickDimensions();
    await this.refreshInputsStatus();
  },
  async pickGuidance(): Promise<void> {
    await window.ulms.pickGuidance();
    await this.refreshInputsStatus();
  },
  async clearGuidance(): Promise<void> {
    await window.ulms.clearGuidance();
    await this.refreshInputsStatus();
  },
  async startWorkflow(): Promise<void> {
    await window.ulms.startWorkflow();
  },
  async stopWorkflow(): Promise<void> {
    await window.ulms.stopWorkflow();
  },
  async startSecondOpinion(): Promise<void> {
    await window.ulms.startSecondOpinion();
  },
  async stopSecondOpinion(): Promise<void> {
    await window.ulms.stopSecondOpinion();
  },
};
