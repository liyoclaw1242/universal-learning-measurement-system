// Inline editor for the staged competency dimensions used by the Quiz
// pipeline. Each row holds dim_id + name + description; rows can be
// reordered with up/down buttons, deleted, or added. Save persists via
// the host-provided callback (which calls update_dimensions backend).

import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Trash2, Plus, Save, X } from 'lucide-react';
import type { CompetencyDimension as Dimension } from '../../types/dimension';

interface DimensionsEditorProps {
  initial: Dimension[];
  onSave: (dims: Dimension[]) => Promise<void>;
  onCancel?: () => void;
}

interface Draft extends Dimension {
  /** stable client-side row id so React keys survive reorders even
   *  when dim_id is being edited / temporarily duplicated. */
  _key: string;
}

let _keyCounter = 0;
function nextKey(): string {
  _keyCounter += 1;
  return `row-${_keyCounter}`;
}

function withKeys(dims: Dimension[]): Draft[] {
  return dims.map((d) => ({ ...d, _key: nextKey() }));
}

export default function DimensionsEditor({ initial, onSave, onCancel }: DimensionsEditorProps) {
  const [rows, setRows] = useState<Draft[]>(() => withKeys(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = useMemo(() => validate(rows), [rows]);

  const update = (key: string, patch: Partial<Dimension>) => {
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...patch } : r)));
  };
  const addRow = () => {
    setRows((rs) => [
      ...rs,
      { _key: nextKey(), dim_id: '', name: '', description: '' },
    ]);
  };
  const deleteRow = (key: string) => {
    setRows((rs) => rs.filter((r) => r._key !== key));
  };
  const move = (key: string, dir: -1 | 1) => {
    setRows((rs) => {
      const idx = rs.findIndex((r) => r._key === key);
      if (idx < 0) return rs;
      const target = idx + dir;
      if (target < 0 || target >= rs.length) return rs;
      const next = rs.slice();
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };

  const handleSave = async () => {
    if (validation.error) {
      setError(validation.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const clean: Dimension[] = rows.map(({ _key, ...rest }) => {
        void _key;
        return rest;
      });
      await onSave(clean);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dimensions-editor">
      <header className="dimensions-editor-head">
        <div>
          <h2>Edit dimensions</h2>
          <p className="ulms-meta">
            {rows.length} dimension{rows.length === 1 ? '' : 's'} · save will overwrite the
            staged YAML and write <code>workspace/inputs/edited-dimensions.yaml</code>
          </p>
        </div>
        <div className="dimensions-editor-actions">
          {onCancel && (
            <button className="btn ghost" onClick={onCancel} disabled={saving}>
              <X size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
              Cancel
            </button>
          )}
          <button
            className="btn primary"
            onClick={() => void handleSave()}
            disabled={saving || !!validation.error}
            title={validation.error ?? undefined}
          >
            <Save size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      {error && <div className="dimensions-editor-error">{error}</div>}

      <div className="dimensions-editor-list">
        {rows.map((row, idx) => (
          <div key={row._key} className="dimension-row">
            <div className="dimension-row-meta">
              <span className="row-index">#{idx + 1}</span>
              <button
                className="row-icon-btn"
                onClick={() => move(row._key, -1)}
                disabled={idx === 0}
                aria-label="move up"
              >
                <ArrowUp size={12} />
              </button>
              <button
                className="row-icon-btn"
                onClick={() => move(row._key, 1)}
                disabled={idx === rows.length - 1}
                aria-label="move down"
              >
                <ArrowDown size={12} />
              </button>
              <button
                className="row-icon-btn danger"
                onClick={() => deleteRow(row._key)}
                aria-label="delete row"
                title="delete this dimension"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="dimension-row-fields">
              <label className="ulms-label">DIM_ID</label>
              <input
                type="text"
                className="dim-input"
                value={row.dim_id}
                onChange={(e) => update(row._key, { dim_id: e.target.value })}
                placeholder="snake_case_id"
                spellCheck={false}
              />
              <label className="ulms-label">NAME</label>
              <input
                type="text"
                className="dim-input"
                value={row.name}
                onChange={(e) => update(row._key, { name: e.target.value })}
                placeholder="簡短中文名稱"
              />
              <label className="ulms-label">DESCRIPTION</label>
              <textarea
                className="dim-textarea"
                value={row.description}
                onChange={(e) => update(row._key, { description: e.target.value })}
                placeholder="學習者應達成的理解程度與可觀察行為"
                rows={3}
              />
            </div>
          </div>
        ))}
      </div>

      <button className="btn ghost dimensions-editor-add" onClick={addRow}>
        <Plus size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
        Add dimension
      </button>
    </div>
  );
}

function validate(rows: Draft[]): { error: string | null } {
  if (rows.length === 0) {
    return { error: 'at least one dimension is required' };
  }
  const ids = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const id = r.dim_id.trim();
    if (!id) return { error: `row ${i + 1}: dim_id is empty` };
    if (!r.name.trim()) return { error: `row ${i + 1} (${id}): name is empty` };
    if (ids.has(id)) return { error: `duplicate dim_id "${id}"` };
    ids.add(id);
  }
  return { error: null };
}
