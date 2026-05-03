// Renderer-side IPC bridge — Tauri 2 port of the Electron version.
// Wraps @tauri-apps/api invoke + listen so the rest of the renderer can
// keep using a single `bridge.*` import surface.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LearnSessionMeta,
  McpSetup,
  RawResourceDetail,
  RawResourceSummary,
  RunMeta,
  WikiConceptMeta as UiWikiConceptMeta,
  WikiSynthesizeReport,
} from '@ulms/ui';
import { useShellStore } from './shellStore';
import { translateBoard, type TranslateInput } from './translateBoard';

// ─── shared helpers ─────────────────────────────────────

interface AgentStreamMsg {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
      content?: unknown;
    }>;
  };
  total_cost_usd?: number;
  duration_ms?: number;
  [key: string]: unknown;
}

function nowHMS(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatToolInputPreview(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const i = input as Record<string, unknown>;
  if (name === 'Read' || name === 'Write') return String(i.file_path ?? '');
  if (name === 'Bash') return String(i.command ?? '');
  return JSON.stringify(i).slice(0, 120);
}

// listen() returns Promise<UnlistenFn>; setupIpcBridge runs once at
// module load (before React mounts), so StrictMode double-invoke isn't
// a concern. Still tracking unsubs for the hot-reload path.
type Listener<T> = (payload: T) => void;
function on<T>(event: string, cb: Listener<T>): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

// ─── inbound event subscriptions ────────────────────────

export function setupIpcBridge(): () => void {
  const { _pushWarning } = useShellStore.getState();
  const unsubs: Array<UnlistenFn> = [];
  const track = (p: Promise<UnlistenFn>) => {
    p.then((u) => unsubs.push(u)).catch((err) => {
      console.error('listener registration failed', err);
    });
  };

  // ─── inputs status (initial fetch) ──────────────────
  void invoke('inputs_status').then((st) => {
    useShellStore.getState()._onInputsStatus(st as never);
  });

  // ─── workflow lifecycle ─────────────────────────────
  track(
    on<{ isResume?: boolean; startFromAgent?: string }>('workflow:started', (p) =>
      useShellStore.getState()._onWorkflowStarted(p),
    ),
  );
  track(
    on<unknown>('workflow:completed', () =>
      useShellStore.getState()._onWorkflowCompleted(),
    ),
  );
  track(
    on<{ error: string }>('workflow:error', ({ error }) =>
      useShellStore.getState()._onWorkflowError(error),
    ),
  );

  // ─── board updates ──────────────────────────────────
  track(
    on<{ board: unknown }>('board:updated', ({ board }) => {
      const b = board as
        | {
            user_input?: { material?: { filename?: string; content?: string } };
            costs?: { total_usd?: number };
          }
        | null;
      if (!b) return;
      const state = useShellStore.getState();

      useShellStore.setState({
        session: {
          ...state.session,
          cost_usd:
            typeof b.costs?.total_usd === 'number' ? b.costs.total_usd : state.session.cost_usd,
          material: b.user_input?.material?.filename ?? state.session.material,
        },
      });

      const translated = translateBoard(board as TranslateInput);
      useShellStore.getState()._onTranslatedItems(translated);
    }),
  );

  // ─── agent lifecycle ────────────────────────────────
  track(
    on<{ agent: string }>('agent:started', ({ agent }) => {
      useShellStore.getState()._onAgentStarted(agent);
      useShellStore
        .getState()
        ._onAgentStreamLine(agent, nowHMS(), 'summary', `── ${agent} starting ──`);
    }),
  );

  track(
    on<{
      agent: string;
      exit_code: number | null;
      result: { total_cost_usd?: number; duration_ms?: number; subtype?: string } | null;
    }>('agent:completed', (p) => {
      const cost = p.result?.total_cost_usd ?? 0;
      const durationS = (p.result?.duration_ms ?? 0) / 1000;
      useShellStore.getState()._onAgentCompleted(p.agent, cost, durationS);
      const line = `✔ ${p.result?.subtype ?? 'exit ' + p.exit_code} · $${cost.toFixed(4)} · ${durationS.toFixed(1)}s`;
      useShellStore.getState()._onAgentStreamLine(p.agent, nowHMS(), 'done', line);
    }),
  );

  track(
    on<{ agent: string; msg: AgentStreamMsg }>('agent:stream', ({ agent, msg }) => {
      const m = msg;
      if (m.type === 'system' && m.subtype === 'init') {
        useShellStore
          .getState()
          ._onAgentStreamLine(
            agent,
            nowHMS(),
            'thought',
            `session ${String(m.session_id).slice(0, 8)}`,
          );
        return;
      }
      if (m.type === 'assistant' && m.message?.content) {
        for (const block of m.message.content) {
          if (block.type === 'text' && block.text) {
            useShellStore
              .getState()
              ._onAgentStreamLine(agent, nowHMS(), 'thought', block.text.slice(0, 300));
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
      if (m.type === 'result') return;
    }),
  );

  track(
    on<{ agent: string; line: string }>('agent:raw', ({ agent, line }) => {
      useShellStore.getState()._onAgentStreamLine(agent, nowHMS(), 'warn', line.slice(0, 200));
    }),
  );

  // ─── schema warnings ────────────────────────────────
  track(
    on<{ agent: string; warnings: string[] }>('schema:warn', ({ agent, warnings }) => {
      for (const w of warnings) _pushWarning(`[${agent}] ${w}`);
    }),
  );

  // ─── Gemini second opinion ──────────────────────────
  track(
    on<unknown>('gemini:started', () => {
      const s = useShellStore.getState();
      s._onGeminiStarted();
      s._onGeminiStreamLine(nowHMS(), 'summary', '── gemini reviewer starting ──');
    }),
  );

  track(
    on<{
      exit_code: number | null;
      result: { total_tokens?: number; duration_ms?: number } | null;
    }>('gemini:completed', (p) => {
      const s = useShellStore.getState();
      s._onGeminiStopped();
      if (p.result) {
        s._onGeminiStreamLine(
          nowHMS(),
          'done',
          `✔ exit ${p.exit_code} · ${p.result.total_tokens ?? 0} tokens · ${((p.result.duration_ms ?? 0) / 1000).toFixed(1)}s`,
        );
      }
    }),
  );

  track(
    on<{ msg: unknown }>('gemini:stream', ({ msg }) => {
      const m = msg as {
        type: string;
        role?: 'user' | 'assistant';
        content?: string;
        delta?: boolean;
        session_id?: string;
        model?: string;
      };
      const s = useShellStore.getState();
      if (m.type === 'init') {
        s._onGeminiStreamLine(
          nowHMS(),
          'thought',
          `session ${String(m.session_id ?? '').slice(0, 8)} · model ${m.model ?? '?'}`,
        );
        return;
      }
      if (m.type === 'message' && m.role === 'assistant' && m.content) {
        s._onGeminiStreamLine(nowHMS(), 'thought', m.content.slice(0, 300));
        return;
      }
      if (m.type === 'message' && m.role === 'user' && m.content) {
        s._onGeminiStreamLine(nowHMS(), 'tool', `user → ${m.content.slice(0, 160)}`);
        return;
      }
      if (m.type !== 'result' && m.type !== 'message') {
        s._onGeminiStreamLine(nowHMS(), 'warn', `(${m.type})`);
      }
    }),
  );

  track(
    on<{ line: string }>('gemini:raw', ({ line }) => {
      useShellStore.getState()._onGeminiStreamLine(nowHMS(), 'warn', line.slice(0, 200));
    }),
  );

  track(
    on<{
      merged_summary?: {
        total_items?: number;
        verdict_agreement_rate?: number;
        merged_verdict_counts?: { accept?: number; needs_revision?: number; reject?: number };
        disagreement_item_ids?: string[];
      };
    }>('second-opinion:completed', (p) => {
      useShellStore.getState()._onGeminiStopped();
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

  track(
    on<{ error: string }>('second-opinion:error', ({ error }) => {
      useShellStore.getState()._onGeminiStopped();
      _pushWarning(`[gemini] ${error}`);
    }),
  );

  // ─── regenerate ─────────────────────────────────────
  track(
    on<{ item_id: string }>('regenerate:started', ({ item_id }) => {
      useShellStore.getState()._onRegenerateStarted(item_id);
    }),
  );

  track(
    on<unknown>('regenerate:completed', () => {
      useShellStore.getState()._onRegenerateFinished('');
    }),
  );

  track(
    on<{ item_id: string; error: string }>('regenerate:error', ({ item_id, error }) => {
      useShellStore.getState()._onRegenerateFinished(item_id);
      _pushWarning(`[regenerate:${item_id}] ${error}`);
    }),
  );

  track(
    on<{ item_ids: string[] }>('regenerate-batch:started', ({ item_ids }) => {
      useShellStore.getState()._onRegenerateBatchStarted(item_ids);
    }),
  );

  track(
    on<{ remaining: number }>('regenerate-batch:item-done', ({ remaining }) => {
      useShellStore.getState()._onRegenerateBatchItemDone(remaining);
    }),
  );

  track(
    on<unknown>('regenerate-batch:completed', () => {
      useShellStore.getState()._onRegenerateBatchCompleted();
    }),
  );

  // ─── learn / translation ────────────────────────────
  track(
    on<{ capture_index: number; image_path: string }>(
      'translation:capture-started',
      ({ capture_index, image_path }) => {
        useShellStore.getState()._onTranslationCaptureStarted(capture_index, image_path);
      },
    ),
  );

  track(
    on<{
      capture_index: number;
      image_path: string;
      text: string;
      notes_path: string;
    }>('translation:completed', (p) => {
      useShellStore.getState()._onTranslationCompleted({
        index: p.capture_index,
        imagePath: p.image_path,
        text: p.text,
        notesPath: p.notes_path,
      });
    }),
  );

  track(
    on<{ error: string }>('translation:error', ({ error }) => {
      useShellStore.getState()._onTranslationError(error);
    }),
  );

  // translation:stream is currently informational (raw stream-json
  // messages); subscribe so future UX can show live progress.
  track(
    on<{ msg: unknown }>('translation:stream', () => {
      // no-op for now; placeholder for streaming-text UX
    }),
  );

  track(
    on<unknown>('paper-window:closed', () => {
      useShellStore.getState()._onPaperSessionClosed();
    }),
  );

  return () => {
    for (const u of unsubs) u();
  };
}

// ─── imperative bridge helpers (called from components) ─

export const bridge = {
  async refreshInputsStatus(): Promise<void> {
    const status = await invoke('inputs_status');
    useShellStore.getState()._onInputsStatus(status as never);
  },
  async pickMaterial(): Promise<void> {
    await invoke('pick_material');
    await this.refreshInputsStatus();
  },
  async pickDimensions(): Promise<void> {
    await invoke('pick_dimensions');
    await this.refreshInputsStatus();
  },
  async pickGuidance(): Promise<void> {
    await invoke('pick_guidance');
    await this.refreshInputsStatus();
  },
  async clearGuidance(): Promise<void> {
    await invoke('clear_guidance');
    await this.refreshInputsStatus();
  },
  async startWorkflow(): Promise<void> {
    await invoke('start_workflow');
  },
  async stopWorkflow(): Promise<void> {
    await invoke('stop_workflow');
  },
  async startSecondOpinion(): Promise<void> {
    await invoke('start_second_opinion');
  },
  async stopSecondOpinion(): Promise<void> {
    await invoke('stop_second_opinion');
  },
  async applyItemOverride(
    itemId: string,
    override: 'flag' | 'reject' | 'promote' | 'ship' | null,
  ): Promise<void> {
    await invoke('apply_item_override', { itemId, override });
  },
  async exportItems(): Promise<{ ok: boolean; error?: string; paths?: string[] }> {
    return (await invoke('export_items')) as { ok: boolean; error?: string; paths?: string[] };
  },
  async regenerateItem(itemId: string): Promise<void> {
    await invoke('regenerate_item', { itemId });
  },
  async regenerateRejected(): Promise<void> {
    await invoke('regenerate_rejected');
  },

  // ─── learn / translation ─────────────────────────────────
  async startPaperSession(url: string): Promise<void> {
    const session = (await invoke('start_paper_session', { url })) as {
      id: string;
      source_url: string;
      pdf_path: string;
      notes_path: string;
    };
    useShellStore.getState()._onPaperSessionStarted({
      sessionId: session.id,
      sourceUrl: session.source_url,
      pdfPath: session.pdf_path,
      notesPath: session.notes_path,
    });
  },
  async translatePage(pageNum: number, imageB64: string): Promise<void> {
    await invoke('translate_page', { pageNum, imageB64 });
  },
  async stopTranslation(): Promise<void> {
    await invoke('stop_translation');
  },
  async closePaperSession(): Promise<void> {
    await invoke('close_paper_session');
  },
  async importTranslationAsMaterial(): Promise<void> {
    await invoke('import_translation_as_material');
    useShellStore.getState()._onMaterialImportedFromTranslation();
    await this.refreshInputsStatus();
  },
  async listLearnSessions(): Promise<LearnSessionMeta[]> {
    const raw = (await invoke('list_learn_sessions')) as Array<{
      id: string;
      source_url: string | null;
      capture_count: number;
      modified_at: string;
    }>;
    return raw.map((r) => ({
      id: r.id,
      sourceUrl: r.source_url,
      captureCount: r.capture_count,
      modifiedAt: r.modified_at,
    }));
  },
  async deleteLearnSession(sessionId: string): Promise<void> {
    await invoke('delete_learn_session', { sessionId });
  },
  async importSessionsAsMaterial(sessionIds: string[]): Promise<void> {
    await invoke('import_sessions_as_material', { sessionIds });
    useShellStore.getState()._onMaterialImportedFromTranslation();
    await this.refreshInputsStatus();
  },
  async generateDimensions(): Promise<number> {
    const dims = (await invoke('generate_dimensions')) as Array<unknown>;
    await this.refreshInputsStatus();
    return dims.length;
  },
  async getDimensions(): Promise<
    Array<{ dim_id: string; name: string; description: string }>
  > {
    return (await invoke('get_dimensions')) as Array<{
      dim_id: string;
      name: string;
      description: string;
    }>;
  },
  async updateDimensions(
    dimensions: Array<{ dim_id: string; name: string; description: string }>,
  ): Promise<number> {
    const n = (await invoke('update_dimensions', { dimensions })) as number;
    await this.refreshInputsStatus();
    return n;
  },
  async resumeLearnSession(sessionId: string): Promise<void> {
    const resp = (await invoke('resume_learn_session', { sessionId })) as {
      session: {
        id: string;
        source_url: string;
        pdf_path: string;
        notes_path: string;
        capture_count: number;
      };
      captures: Array<{
        index: number;
        image_path: string;
        text: string;
        ts: string;
      }>;
    };
    useShellStore.getState()._onResumeLearnSession({
      sessionId: resp.session.id,
      sourceUrl: resp.session.source_url,
      pdfPath: resp.session.pdf_path,
      notesPath: resp.session.notes_path,
      captures: resp.captures.map((c) => ({
        index: c.index,
        imagePath: c.image_path,
        text: c.text,
        ts: c.ts,
      })),
    });
  },
  async listRuns(): Promise<RunMeta[]> {
    const raw = (await invoke('list_runs')) as Array<{
      id: string;
      timestamp: string;
      material_filename: string | null;
      item_count: number;
      dimension_count: number;
      total_cost_usd: number;
    }>;
    return raw.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      materialFilename: r.material_filename,
      itemCount: r.item_count,
      dimensionCount: r.dimension_count,
      totalCostUsd: r.total_cost_usd,
    }));
  },
  async deleteRun(runId: string): Promise<void> {
    await invoke('delete_run', { runId });
  },
  async synthesizeWiki(): Promise<WikiSynthesizeReport> {
    const r = (await invoke('synthesize_wiki')) as {
      wiki_dir: string;
      run_count: number;
      ku_count: number;
      concepts_written: number;
      skipped_human_edited: string[];
    };
    return {
      wikiDir: r.wiki_dir,
      runCount: r.run_count,
      kuCount: r.ku_count,
      conceptsWritten: r.concepts_written,
      skippedHumanEdited: r.skipped_human_edited,
    };
  },
  async getWikiDir(): Promise<string> {
    return (await invoke('get_wiki_dir')) as string;
  },
  async listWikiConcepts(): Promise<UiWikiConceptMeta[]> {
    const raw = (await invoke('list_wiki_concepts')) as Array<{
      slug: string;
      title: string;
      tags: string[];
      human_edited: boolean;
      last_synthesized: string;
    }>;
    return raw.map((r) => ({
      slug: r.slug,
      title: r.title,
      tags: r.tags,
      humanEdited: r.human_edited,
      lastSynthesized: r.last_synthesized,
    }));
  },
  async readWikiConcept(slug: string): Promise<string> {
    return (await invoke('read_wiki_concept', { slug })) as string;
  },
  async writeWikiConcept(slug: string, body: string): Promise<void> {
    await invoke('write_wiki_concept', { slug, body });
  },

  // ─── chrome-ext / raw bank ───────────────────────────────
  async getExtToken(): Promise<string> {
    return (await invoke('get_ext_token')) as string;
  },
  async readRawResource(resourceType: string, id: string): Promise<RawResourceDetail> {
    const r = (await invoke('read_raw_resource', { resourceType, id })) as {
      meta: {
        id: string;
        type: string;
        source_url: string;
        title: string;
        captured_at: string;
        captured_via: string;
        verified: boolean;
        quizzed_in: string[];
        char_count: number | null;
        duration_s: number | null;
        channel: string | null;
        caption_lang: string | null;
        page_count: number | null;
        author: string | null;
      };
      body: string;
      thumbnail_data_url: string | null;
    };
    return {
      meta: {
        id: r.meta.id,
        type: r.meta.type,
        sourceUrl: r.meta.source_url,
        title: r.meta.title,
        capturedAt: r.meta.captured_at,
        capturedVia: r.meta.captured_via,
        verified: r.meta.verified,
        quizzedIn: r.meta.quizzed_in,
        charCount: r.meta.char_count,
        durationS: r.meta.duration_s,
        channel: r.meta.channel,
        captionLang: r.meta.caption_lang,
        pageCount: r.meta.page_count,
        author: r.meta.author,
      },
      body: r.body,
      thumbnailDataUrl: r.thumbnail_data_url,
    };
  },
  async listRawResources(): Promise<RawResourceSummary[]> {
    const raw = (await invoke('list_raw_resources')) as Array<{
      id: string;
      type: string;
      source_url: string;
      title: string;
      captured_at: string;
      verified: boolean;
      quizzed_count: number;
    }>;
    return raw.map((r) => ({
      id: r.id,
      type: r.type,
      sourceUrl: r.source_url,
      title: r.title,
      capturedAt: r.captured_at,
      verified: r.verified,
      quizzedCount: r.quizzed_count,
    }));
  },
  async deleteRawResource(resourceType: string, id: string): Promise<void> {
    await invoke('delete_raw_resource', { resourceType, id });
  },
  async openRawDir(): Promise<void> {
    await invoke('open_raw_dir');
  },
  async importMarkdownFile(filename: string, content: string): Promise<void> {
    await invoke('import_markdown_file', { filename, content });
  },
  async importImageFile(filename: string, contentB64: string): Promise<void> {
    await invoke('import_image_file', { filename, contentB64 });
  },
  async getMcpSetup(): Promise<McpSetup> {
    const r = (await invoke('get_mcp_setup')) as {
      mcp_binary_path: string;
      binary_exists: boolean;
      wiki_dir: string;
      workspace_dir: string;
      claude_desktop_config_path: string;
      config_snippet: string;
    };
    return {
      mcpBinaryPath: r.mcp_binary_path,
      binaryExists: r.binary_exists,
      wikiDir: r.wiki_dir,
      workspaceDir: r.workspace_dir,
      claudeDesktopConfigPath: r.claude_desktop_config_path,
      configSnippet: r.config_snippet,
    };
  },
};

// Type surface for renderer consumers — all DTO shapes live in @ulms/ui
// so presentational components can consume them without importing the
// Tauri bridge.
export type {
  LearnSessionMeta,
  McpSetup,
  RawResourceDetail,
  RawResourceSummary,
  RunMeta,
  WikiConceptMeta,
  WikiSynthesizeReport,
} from '@ulms/ui';
