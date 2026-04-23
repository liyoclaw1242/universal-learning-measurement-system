// WarningsTray — floating bottom-right list of the N most recent warnings.
// Each entry has a dismiss button. Non-blocking: the tray doesn't
// intercept pointer events except on the toasts themselves.
//
// Consumer owns the warning list + dismiss handler (store-driven).

interface WarningsTrayProps {
  warnings: string[];
  /** how many most-recent warnings to display (default 3) */
  max?: number;
  /** dismiss a specific warning by its index within `warnings` */
  onDismiss?: (index: number) => void;
  /** dismiss all warnings */
  onDismissAll?: () => void;
}

export default function WarningsTray({
  warnings,
  max = 3,
  onDismiss,
  onDismissAll,
}: WarningsTrayProps) {
  if (warnings.length === 0) return null;
  const visible = warnings.slice(-max);
  const startIdx = warnings.length - visible.length;

  return (
    <div className="warnings-tray" aria-live="polite">
      {warnings.length > max && (
        <div className="warning-toast">
          <span className="label">…</span>
          <span className="text">
            +{warnings.length - max} older warnings
          </span>
          {onDismissAll && (
            <button className="dismiss" aria-label="dismiss all" onClick={onDismissAll}>
              ×
            </button>
          )}
        </div>
      )}
      {visible.map((msg, i) => {
        const realIdx = startIdx + i;
        return (
          <div className="warning-toast" key={realIdx}>
            <span className="label">⚠</span>
            <span className="text">{msg}</span>
            {onDismiss && (
              <button className="dismiss" aria-label="dismiss" onClick={() => onDismiss(realIdx)}>
                ×
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
