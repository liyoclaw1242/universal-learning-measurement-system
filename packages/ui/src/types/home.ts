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

/** Full meta + body returned by read_raw_resource. */
export interface RawResourceMetaFull {
  id: string;
  type: string;
  sourceUrl: string;
  title: string;
  capturedAt: string;
  capturedVia: string;
  verified: boolean;
  quizzedIn: string[];
  charCount: number | null;
  durationS: number | null;
  channel: string | null;
  captionLang: string | null;
  pageCount: number | null;
  author: string | null;
}

export interface RawResourceDetail {
  meta: RawResourceMetaFull;
  /** content.md / transcript.md content; empty when no body file exists. */
  body: string;
  /** data: URL for cover thumbnail (youtube) or captured image. null otherwise. */
  thumbnailDataUrl: string | null;
}
