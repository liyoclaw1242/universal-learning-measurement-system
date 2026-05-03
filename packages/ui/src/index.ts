// @ulms/ui — public surface.
// Consumers (apps/shell, apps/*) import components and types from here.
// Design-system styles are imported as side-effect CSS from the
// package subpath exports (e.g. `import '@ulms/ui/styles/shell.css'`).

export { default as Ribbon } from './components/Ribbon';
export type { RibbonTab } from './components/Ribbon';

export { default as ModeBar } from './components/ModeBar';

export { default as StatusBar } from './components/StatusBar';

export { default as NavRail } from './components/NavRail';
export type { LearnSession } from './components/NavRail';

export { default as TranslationPanel } from './components/TranslationPanel';
export type { TranslationCapture } from './components/TranslationPanel';

export { default as DimensionsEditor } from './components/DimensionsEditor';

export { default as WikiSidebar } from './components/WikiSidebar';
export { default as WikiViewer } from './components/WikiViewer';

export { default as PdfReader } from './components/PdfReader';

export { default as HomeView } from './components/HomeView';
export { default as RecentSessionRow } from './components/RecentSessionRow';
export { default as McpSetupPanel } from './components/McpSetupPanel';

export { default as TabBar } from './components/TabBar';
export type { Tab, TabId } from './components/TabBar';

export { default as OverviewTab } from './components/OverviewTab';
export { default as ItemDetailTab } from './components/ItemDetailTab';
export { default as TerminalTab } from './components/TerminalTab';
export { default as WarningsTray } from './components/WarningsTray';

// Domain types — re-exported from the single aggregate module.
export * from './types';
