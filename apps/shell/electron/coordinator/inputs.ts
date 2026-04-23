// Input loaders: pick a file via Electron dialog, read + validate, copy
// into workspace/inputs/, stage in memory until workflow start.
// Port of spike v3 loadMaterial / loadDimensions / loadGuidance.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import yaml from 'js-yaml';
import type { AssessmentParams, Dimension, MaterialInput, StagedInputs } from './types';

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
  material: { filename: string; char_count: number } | null;
  dimensions: { count: number; ids: string[] } | null;
  guidance: { char_count: number } | null;
  assessment_params: AssessmentParams | null;
  ready: boolean;
}

export function getStatus(): InputsStatus {
  return {
    material: staged.material
      ? { filename: staged.material.filename, char_count: staged.material.content.length }
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

export async function pickMaterial(
  win: BrowserWindow | null,
  workspaceDir: string,
): Promise<{ status: 'ok' | 'canceled' | 'error'; error?: string }> {
  const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
    filters: [{ name: 'Material', extensions: ['md', 'txt', 'markdown'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths[0]) return { status: 'canceled' };
  try {
    const srcPath = res.filePaths[0];
    const content = await fs.readFile(srcPath, 'utf-8');
    const filename = await copyToInputsDir(workspaceDir, srcPath, content);
    const ext = path.extname(filename).toLowerCase();
    staged.material = {
      filename,
      content,
      content_type: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
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
