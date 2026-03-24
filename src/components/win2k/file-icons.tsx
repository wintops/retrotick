// Shared file-type icons (16px and 32px) for desktop and file dialogs.

// --- Text file icon: white page with blue text lines ---

const TEXT_ICON_32 = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 0h18l8 8v23a1 1 0 01-1 1H3a1 1 0 01-1-1V1a1 1 0 011-1z" fill="#fff" stroke="#808080" stroke-width="1"/>
    <path d="M21 0v7a1 1 0 001 1h7" fill="#e0e0e0" stroke="#808080" stroke-width="1"/>
    <rect x="6" y="12" width="16" height="2" fill="#000080"/>
    <rect x="6" y="17" width="16" height="2" fill="#000080"/>
    <rect x="6" y="22" width="10" height="2" fill="#000080"/>
  </svg>
);

const TEXT_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
    <path d="M3 0h18l8 8v23a1 1 0 01-1 1H3a1 1 0 01-1-1V1a1 1 0 011-1z" fill="#fff" stroke="#808080" stroke-width="1"/>
    <path d="M21 0v7a1 1 0 001 1h7" fill="#e0e0e0" stroke="#808080" stroke-width="1"/>
    <rect x="6" y="12" width="16" height="2" fill="#000080"/>
    <rect x="6" y="17" width="16" height="2" fill="#000080"/>
    <rect x="6" y="22" width="10" height="2" fill="#000080"/>
  </svg>
);

// --- Generic file icon: gray page, no text lines ---

const GENERIC_ICON_32 = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 0h18l8 8v23a1 1 0 01-1 1H3a1 1 0 01-1-1V1a1 1 0 011-1z" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <path d="M21 0v7a1 1 0 001 1h7" fill="#e0e0e0" stroke="#808080" stroke-width="1"/>
  </svg>
);

const GENERIC_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
    <path d="M3 0h18l8 8v23a1 1 0 01-1 1H3a1 1 0 01-1-1V1a1 1 0 011-1z" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <path d="M21 0v7a1 1 0 001 1h7" fill="#e0e0e0" stroke="#808080" stroke-width="1"/>
  </svg>
);

// --- EXE icon: window with blue title bar ---

const EXE_ICON_32 = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="2" width="32" height="28" rx="1" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <rect x="1" y="3" width="30" height="4" fill="#000080"/>
    <rect x="24" y="3" width="4" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="28" y="3" width="3" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="3" y="4" width="10" height="2" fill="#ffffff"/>
    <rect x="2" y="9" width="28" height="19" fill="#ffffff" stroke="#808080" stroke-width="0.5"/>
  </svg>
);

const EXE_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="2" width="32" height="28" rx="1" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <rect x="1" y="3" width="30" height="4" fill="#000080"/>
    <rect x="24" y="3" width="4" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="28" y="3" width="3" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="3" y="4" width="10" height="2" fill="#ffffff"/>
    <rect x="2" y="9" width="28" height="19" fill="#ffffff" stroke="#808080" stroke-width="0.5"/>
  </svg>
);

// --- Folder icon ---

const FOLDER_ICON_32 = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 7h14l2-4h16v3H16l-2 4H0z" fill="#C4A000"/>
    <rect x="0" y="9" width="32" height="21" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
    <rect x="0" y="7" width="14" height="3" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
  </svg>
);

const FOLDER_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 7h14l2-4h16v3H16l-2 4H0z" fill="#C4A000"/>
    <rect x="0" y="9" width="32" height="21" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
    <rect x="0" y="7" width="14" height="3" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
  </svg>
);

// --- Text file extensions ---

const TEXT_EXTENSIONS = new Set([
  'txt', 'log', 'ini', 'cfg', 'inf', 'csv', 'xml', 'htm', 'html',
]);

function getExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(getExt(name));
}

function isExeByExtension(name: string): boolean {
  const ext = getExt(name);
  return ext === 'exe' || ext === 'com';
}

// --- Public helpers ---

export interface FileIconOptions {
  isFolder?: boolean;
  /** Extracted PE icon URL (from parsePE) */
  iconUrl?: string | null;
}

/** Return the appropriate 32px icon for a file (desktop, folder windows). */
export function fileIcon32(name: string, opts: FileIconOptions = {}): preact.JSX.Element {
  if (opts.isFolder) return FOLDER_ICON_32;
  if (opts.iconUrl) return <img src={opts.iconUrl} width={32} height={32} draggable={false} style={{ imageRendering: 'pixelated' }} />;
  if (isExeByExtension(name)) return EXE_ICON_32;
  if (isTextFile(name)) return TEXT_ICON_32;
  return GENERIC_ICON_32;
}

/** Return the appropriate 16px icon for a file (file dialog, list views). */
export function fileIcon16(name: string, opts: FileIconOptions = {}): preact.JSX.Element {
  if (opts.isFolder) return FOLDER_ICON_16;
  if (opts.iconUrl) return <img src={opts.iconUrl} width={16} height={16} draggable={false} style={{ imageRendering: 'pixelated' }} />;
  if (isExeByExtension(name)) return EXE_ICON_16;
  if (isTextFile(name)) return TEXT_ICON_16;
  return GENERIC_ICON_16;
}

// Re-export individual icons for backward compat (Taskbar etc.)
export { FOLDER_ICON_16, EXE_ICON_16, FOLDER_ICON_32, EXE_ICON_32, GENERIC_ICON_32, TEXT_ICON_16, TEXT_ICON_32 };
