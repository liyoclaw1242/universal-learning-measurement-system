// Shared types for the Home landing view (consumed by HomeView in
// @ulms/ui and re-exported by the Tauri shell's bridge layer).

export interface LearnSessionMeta {
  id: string;
  sourceUrl: string | null;
  captureCount: number;
  modifiedAt: string;
}

export interface RunMeta {
  id: string;
  timestamp: string;
  materialFilename: string | null;
  itemCount: number;
  dimensionCount: number;
  totalCostUsd: number;
}

export interface McpSetup {
  mcpBinaryPath: string;
  binaryExists: boolean;
  wikiDir: string;
  workspaceDir: string;
  claudeDesktopConfigPath: string;
  configSnippet: string;
}

export interface WikiSynthesizeReport {
  wikiDir: string;
  runCount: number;
  kuCount: number;
  conceptsWritten: number;
  skippedHumanEdited: string[];
}

/** Summary of a single resource in `~/.ulms-wiki/raw/<type>/<id>/`. */
export interface RawResourceSummary {
  id: string;
  /** "article" | "youtube" | "paper" | "image" | "markdown" — string for forward-compat. */
  type: string;
  sourceUrl: string;
  title: string;
  capturedAt: string;
  verified: boolean;
  quizzedCount: number;
}
