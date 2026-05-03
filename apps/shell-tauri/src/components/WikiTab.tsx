// WikiTab — thin Tauri-side orchestrator that owns concept list +
// content state and threads bridge calls into the pure presentational
// WikiSidebar / WikiViewer components in @ulms/ui.

import { useEffect, useRef, useState } from 'react';
import { WikiSidebar, WikiViewer, type WikiConceptMeta } from '@ulms/ui';
import { bridge } from '@/state/ipcBridge';

export default function WikiTab() {
  const [concepts, setConcepts] = useState<WikiConceptMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [readError, setReadError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthMsg, setSynthMsg] = useState<string | null>(null);
  const reloadTick = useRef(0);

  const reloadList = () => {
    setLoadError(null);
    bridge
      .listWikiConcepts()
      .then(setConcepts)
      .catch((e) => setLoadError(String(e)));
  };

  useEffect(() => {
    reloadList();
  }, []);

  // Auto-select first concept once list arrives.
  useEffect(() => {
    if (!selectedSlug && concepts.length > 0) {
      setSelectedSlug(concepts[0].slug);
    }
  }, [concepts, selectedSlug]);

  // Load body whenever selection or reload-tick changes.
  useEffect(() => {
    if (!selectedSlug) {
      setContent('');
      return;
    }
    let cancelled = false;
    setReadError(null);
    bridge
      .readWikiConcept(selectedSlug)
      .then((c) => {
        if (cancelled) return;
        setContent(c);
        setEditing(false);
        setDraft('');
      })
      .catch((e) => {
        if (cancelled) return;
        setReadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, reloadTick.current]);

  const onStartEdit = () => {
    setDraft(content);
    setEditing(true);
  };

  const onCancelEdit = () => {
    setDraft('');
    setEditing(false);
  };

  const onSave = async () => {
    if (!selectedSlug) return;
    setSaving(true);
    try {
      await bridge.writeWikiConcept(selectedSlug, draft);
      const fresh = await bridge.readWikiConcept(selectedSlug);
      setContent(fresh);
      setEditing(false);
      setDraft('');
      reloadList(); // refresh sidebar so the human-edited badge appears
    } catch (e) {
      alert(`Save failed: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  const onSynthesize = async () => {
    setSynthesizing(true);
    setSynthMsg(null);
    try {
      const r = await bridge.synthesizeWiki();
      setSynthMsg(
        `✓ ${r.conceptsWritten} concept page${r.conceptsWritten === 1 ? '' : 's'} written` +
          (r.skippedHumanEdited.length > 0
            ? ` · ${r.skippedHumanEdited.length} skipped (human-edited)`
            : ''),
      );
      reloadList();
      reloadTick.current++; // re-read current selection in case it changed
    } catch (e) {
      alert(`Synthesize failed: ${e}`);
    } finally {
      setSynthesizing(false);
    }
  };

  const selected = concepts.find((c) => c.slug === selectedSlug) ?? null;

  return (
    <div className="wiki-tab">
      <WikiSidebar
        concepts={concepts}
        filter={filter}
        selectedSlug={selectedSlug}
        loadError={loadError}
        onFilterChange={setFilter}
        onSelect={setSelectedSlug}
      />
      <WikiViewer
        title={selected?.title ?? ''}
        slug={selectedSlug}
        content={content}
        isHumanEdited={!!selected?.humanEdited}
        isEditing={editing}
        isSaving={saving}
        isSynthesizing={synthesizing}
        draft={draft}
        hasAnyConcept={concepts.length > 0}
        loadError={readError}
        synthMsg={synthMsg}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onSave={() => void onSave()}
        onSynthesize={() => void onSynthesize()}
        onDraftChange={setDraft}
      />
    </div>
  );
}
