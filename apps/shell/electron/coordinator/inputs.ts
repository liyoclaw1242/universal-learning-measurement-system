// Input loaders: pick a file via Electron dialog, read + validate, copy
// into workspace/inputs/, stage in memory until workflow start.
// Port of spike v3 loadMaterial / loadDimensions / loadGuidance.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import yaml from 'js-yaml';
import type {
  AssessmentParams,
  Dimension,
  MaterialInput,
  MaterialSource,
  StagedInputs,
} from './types';

// Module-level staged state. Cleared by startWorkflow's resetBlackboard.
const staged: StagedInputs = {
  material: null,
  dimensions: null,
  assessment_params: null,
  domain_guidance: null,
};

export function getStaged(): StagedInputs {
  return staged;
}

export function inputsReady(): boolean {
  return !!(staged.material && staged.dimensions && staged.dimensions.length > 0);
}

export interface InputsStatus {
  material:
    | {
        filename: string;
        char_count: number;
        source_count: number;
        sources: MaterialSource[];
      }
    | null;
  dimensions: { count: number; ids: string[] } | null;
  guidance: { char_count: number } | null;
  assessment_params: AssessmentParams | null;
  ready: boolean;
}

export function getStatus(): InputsStatus {
  const m = staged.material;
  return {
    material: m
      ? {
          filename: m.filename,
          char_count: m.content.length,
          source_count: m.sources?.length ?? 1,
          sources: m.sources ?? [{ filename: m.filename, char_count: m.content.length }],
        }
      : null,
    dimensions: staged.dimensions
      ? { count: staged.dimensions.length, ids: staged.dimensions.map((d) => d.dim_id) }
      : null,
    guidance: staged.domain_guidance ? { char_count: staged.domain_guidance.length } : null,
    assessment_params: staged.assessment_params,
    ready: inputsReady(),
  };
}

async function copyToInputsDir(workspaceDir: string, srcPath: string, contents: string): Promise<string> {
  const inputsDir = path.join(workspaceDir, 'inputs');
  await fs.mkdir(inputsDir, { recursive: true });
  const filename = path.basename(srcPath);
  const destPath = path.join(inputsDir, filename);
  await fs.writeFile(destPath, contents);
  return filename;
}

// ─── individual loaders ─────────────────────────────────────

/** Combined-label for the materials slot, capped so the UI doesn't
 *  overflow on many files. */
function buildCombinedFilename(sources: MaterialSource[]): string {
  if (sources.length === 0) return '—';
  if (sources.length === 1) return sources[0].filename;
  if (sources.length === 2) return `${sources[0].filename} + ${sources[1].filename}`;
  return `${sources[0].filename} + ${sources.length - 1} others`;
}

/** Concatenate multiple files with HTML-comment boundary markers.
 *  The markers are:
 *    · invisible in rendered markdown (agent/reviewer outputs stay clean)
 *    · visible as raw text to the LLM via Read tool (source_excerpt
 *      quotes pick them up if they straddle a boundary — acceptable
 *      trade-off for Path A; see conversation). */
function concatenateMaterials(parts: Array<{ filename: string; content: string }>): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].content;
  return parts
    .map((p) => `<!-- === FILE: ${p.filename} === -->\n\n${p.content.trimEnd()}\n`)
    .join('\n');
}

export async function pickMaterial(
  win: BrowserWindow | null,
  workspaceDir: string,
): Promise<{ status: 'ok' | 'canceled' | 'error'; error?: string }> {
  const res = await dialog.showOpenDialog(win ?? (undefined as unknown as BrowserWindow), {
    filters: [{ name: 'Material', extensions: ['md', 'txt', 'markdown'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || res.filePaths.length === 0) return { status: 'canceled' };
  try {
    // Preserve the dialog's file order — that's the user's intended
    // sequence. macOS returns the user's click-order via multi-select.
    const parts: Array<{ filename: string; content: string }> = [];
    const sources: MaterialSource[] = [];
    let anyMarkdown = false;
    for (const srcPath of res.filePaths) {
      const content = await fs.readFile(srcPath, 'utf-8');
      const filename = await copyToInputsDir(workspaceDir, srcPath, content);
      parts.push({ filename, content });
      sources.push({ filename, char_count: content.length });
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.md' || ext === '.markdown') anyMarkdown = true;
    }
    const joinedContent = concatenateMaterials(parts);
    staged.material = {
      filename: buildCombinedFilename(sources),
      content: joinedContent,
      content_type: anyMarkdown ? 'markdown' : 'text',
      sources: sources.length > 1 ? sources : undefined,
    };
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

export async function pickDimensions(
  win: BrowserWindow | null,
  workspaceDir: string,
): Promise<{ status: 'ok' | 'canceled' | 'error'; error?: string }> {
  const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
    filters: [{ name: 'Dimensions YAML', extensions: ['yaml', 'yml'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
  try {
    const srcPath = res.filePaths[0];
    const text = await fs.readFile(srcPath, 'utf-8');
    const parsed = yaml.load(text) as {
      dimensions?: Dimension[];
      assessment_params?: AssessmentParams;
    } | null;
    if (!parsed || !Array.isArray(parsed.dimensions)) {
      return { status: 'error', error: 'YAML must have a top-level `dimensions` array' };
    }
    staged.dimensions = parsed.dimensions;
    if (parsed.assessment_params) staged.assessment_params = parsed.assessment_params;
    await copyToInputsDir(workspaceDir, srcPath, text);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

export async function pickGuidance(
  win: BrowserWindow | null,
  workspaceDir: string,
): Promise<{ status: 'ok' | 'canceled' | 'error'; error?: string }> {
  const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
    filters: [{ name: 'Guidance', extensions: ['md', 'markdown', 'txt'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
  try {
    const srcPath = res.filePaths[0];
    const content = await fs.readFile(srcPath, 'utf-8');
    staged.domain_guidance = content;
    await copyToInputsDir(workspaceDir, srcPath, content);
    return { status: 'ok' };
  } catch (err) {
    return { status: 'error', error: (err as Error).message };
  }
}

export function clearGuidance(): void {
  staged.domain_guidance = null;
}
