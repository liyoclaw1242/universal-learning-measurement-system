// Competency dimension — the user-facing concept the Quiz pipeline
// consumes. (Note: there's a separate `Dimension` in item.ts that
// represents the dim ID glyph used in review-summary rendering. The
// names overlap historically; keep these types in different files.)

export interface CompetencyDimension {
  /** snake_case identifier referenced by ku_to_dimensions mappings */
  dim_id: string;
  /** display label */
  name: string;
  /** what students should be able to do for this dimension */
  description: string;
}
