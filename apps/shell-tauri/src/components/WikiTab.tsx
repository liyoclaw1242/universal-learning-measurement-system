// WikiTab — thin Tauri-side orchestrator for the Wiki tab.
// Owns two sub-modes: "concepts" (gemini-synthesized topic pages) and
// "raw" (browse ~/.ulms-wiki/raw/<type>/<id>/). Both share a sidebar
// + viewer two-pane layout but render different content.

import { useEffect, useRef, useState } from 'react';
import {
  RawSidebar,
  RawViewer,
  WikiSidebar,
  WikiViewer,
  type RawResourceDetail,
  type RawResourceSummary,
  type WikiConceptMeta,
} from '@ulms/ui';
import { useShellStore } from '@/state/shellStore';
import { bridge } from '@/state/ipcBridge';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

type WikiMode = 'concepts' | 'raw';

export default function WikiTab() {
  const [wikiMode, setWikiMode] = useState<WikiMode>('concepts');
  return (
    <div className="wiki-tab-shell" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <ModeToggle value={wikiMode} onChange={setWikiMode} />
      <div style={{ flex: 1, minHeight: 0 }}>
        {wikiMode === 'concepts' ? <ConceptsPane /> : <RawPane />}
      </div>
    </div>
  );
}

function ModeToggle({
  value,
  onChange,
}: {
  value: WikiMode;
  onChange: (m: WikiMode) => void;
}) {
  return (
    <div className="wiki-mode-toggle" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'concepts'}
        className={value === 'concepts' ? 'active' : ''}
        onClick={() => onChange('concepts')}
      >
        Concepts
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'raw'}
        className={value === 'raw' ? 'active' : ''}
        onClick={() => onChange('raw')}
      >
        Raw materials
      </button>
    </div>
  );
}

// ─── concepts pane (existing behavior) ────────────────────

function ConceptsPane() {
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

  useEffect(() => {
    if (!selectedSlug && concepts.length > 0) {
      setSelectedSlug(concepts[0].slug);
    }
  }, [concepts, selectedSlug]);

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
      reloadList();
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
      reloadTick.current++;
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

// ─── raw materials pane ───────────────────────────────────

function RawPane() {
  const setMode = useShellStore((s) => s.setMode);
  const [resources, setResources] = useState<RawResourceSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<RawResourceDetail | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  // Bumps every time `raw:imported` fires; the detail useEffect
  // depends on it so the body re-fetches mid-translation when PDF
  // Learn appends another page to body.md.
  const [refreshTick, setRefreshTick] = useState(0);

  const reloadList = () => {
    setLoadError(null);
    bridge
      .listRawResources()
      .then(setResources)
      .catch((e) => setLoadError(String(e)));
  };

  useEffect(() => {
    reloadList();
  }, []);

  // Refresh on chrome-ext imports / pdf-learn syncs.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<unknown>('raw:imported', () => {
      if (cancelled) return;
      reloadList();
      setRefreshTick((t) => t + 1);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Auto-select first resource once list arrives.
  useEffect(() => {
    if (!selectedKey && resources.length > 0) {
      const first = resources[0];
      setSelectedKey(`${first.type}/${first.id}`);
    }
  }, [resources, selectedKey]);

  // Load detail on selection change OR when raw:imported bumps the
  // refreshTick (live PDF-Learn body.md growth).
  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      return;
    }
    const slash = selectedKey.indexOf('/');
    if (slash < 0) return;
    const type = selectedKey.slice(0, slash);
    const id = selectedKey.slice(slash + 1);
    let cancelled = false;
    setReadError(null);
    bridge
      .readRawResource(pluralizeType(type), id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
      })
      .catch((e) => {
        if (cancelled) return;
        setReadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedKey, refreshTick]);

  return (
    <div className="wiki-tab">
      <RawSidebar
        resources={resources}
        filter={filter}
        selectedKey={selectedKey}
        loadError={loadError}
        onFilterChange={setFilter}
        onSelect={(type, id) => setSelectedKey(`${type}/${id}`)}
        onMarkdownDrop={async (file) => {
          try {
            const content = await file.text();
            await bridge.importMarkdownFile(file.name, content);
            // raw:imported event auto-refreshes list + detail.
          } catch (e) {
            alert(`Import failed: ${e}`);
          }
        }}
        onImageDrop={async (file) => {
          try {
            const dataUrl = await readAsDataUrl(file);
            const i = dataUrl.indexOf(',');
            const b64 = i < 0 ? '' : dataUrl.slice(i + 1);
            await bridge.importImageFile(file.name, b64);
            // First raw:imported lands immediately (image visible).
            // OCR runs in the background and re-emits raw:imported
            // when body.md is rewritten with the extracted text.
          } catch (e) {
            alert(`Image import failed: ${e}`);
          }
        }}
      />
      <RawViewer
        detail={detail}
        loadError={readError}
        hasAnyResource={resources.length > 0}
        onGoToLearn={(d) => {
          // Phase 1 stub — just switch mode. Phase 2 will load the
          // resource into a type-aware Learn workspace.
          setMode('learn');
          alert(
            `Opening "${d.meta.title}" in Learn — full ${d.meta.type} reader coming next phase.`,
          );
        }}
        onOpenSource={(url) => {
          if (/^https?:\/\//.test(url)) {
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        }}
        onDelete={async (type, id, label) => {
          if (!confirm(`Delete raw resource "${label}"? Folder will be removed.`)) return;
          try {
            await bridge.deleteRawResource(pluralizeType(type), id);
            setResources((prev) => prev.filter((r) => !(r.type === type && r.id === id)));
            const key = `${type}/${id}`;
            if (selectedKey === key) {
              setSelectedKey(null);
              setDetail(null);
            }
          } catch (e) {
            alert(`Delete failed: ${e}`);
          }
        }}
      />
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

// raw_bank stores under plural directory names but the meta.type is
// singular ("article" not "articles"). Bridge expects the plural.
function pluralizeType(t: string): string {
  switch (t) {
    case 'article':
      return 'articles';
    case 'youtube':
      return 'youtube';
    case 'paper':
      return 'papers';
    case 'book':
      return 'books';
    case 'image':
      return 'images';
    case 'markdown':
      return 'markdown';
    default:
      return t;
  }
}
