// Shared types for the Wiki KB layer (consumed by WikiSidebar /
// WikiViewer in @ulms/ui and by the Tauri shell's bridge layer).

export interface WikiConceptMeta {
  slug: string;
  title: string;
  tags: string[];
  humanEdited: boolean;
  /** ISO 8601 timestamp from frontmatter. Optional — the UI may
   *  receive snapshots without it. */
  lastSynthesized?: string;
}
