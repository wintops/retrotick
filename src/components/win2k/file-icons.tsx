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

// --- HLP icon: 2D help book, magenta cover + yellow "?" ---

function HlpBookIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges" style={{ flexShrink: 0 }}>
      {/* Pages peeking out at the right edge */}
      <rect x="25" y="4" width="3" height="25" fill="#FFFFFF" stroke="#000" strokeWidth="1" strokeLinejoin="miter"/>
      <line x1="26" y1="8" x2="27" y2="8" stroke="#C0C0C0" strokeWidth="0.5"/>
      <line x1="26" y1="13" x2="27" y2="13" stroke="#C0C0C0" strokeWidth="0.5"/>
      <line x1="26" y1="19" x2="27" y2="19" stroke="#C0C0C0" strokeWidth="0.5"/>
      <line x1="26" y1="24" x2="27" y2="24" stroke="#C0C0C0" strokeWidth="0.5"/>

      {/* Front cover (purple #BB27C6) */}
      <rect x="3" y="3" width="23" height="26" fill="#BB27C6" stroke="#000" strokeWidth="1" strokeLinejoin="miter"/>

      {/* Spine band on the left — darker purple */}
      <rect x="3" y="3" width="3" height="26" fill="#6F1576"/>
      <rect x="6" y="3" width="1" height="26" fill="#000"/>

      {/* Top highlight */}
      <line x1="8" y1="4" x2="24" y2="4" stroke="#D058E0" strokeWidth="1"/>

      {/* Yellow "?" with black drop shadow */}
      <path d="M 12 11 Q 12 8, 15 8 L 17 8 Q 20 8, 20 12 Q 20 15, 16 16 L 16 19"
            stroke="#000" strokeWidth="3" fill="none" strokeLinecap="square" strokeLinejoin="miter"/>
      <path d="M 12 11 Q 12 8, 15 8 L 17 8 Q 20 8, 20 12 Q 20 15, 16 16 L 16 19"
            stroke="#FFD400" strokeWidth="1.5" fill="none" strokeLinecap="square" strokeLinejoin="miter"/>
      {/* dot */}
      <rect x="14.5" y="21" width="3" height="3" fill="#000"/>
      <rect x="15" y="21.5" width="2" height="2" fill="#FFD400"/>
    </svg>
  );
}

const HLP_ICON_32 = <HlpBookIcon size={32}/>;
const HLP_ICON_16 = <HlpBookIcon size={16}/>;

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
  'txt', 'log', 'ini', 'cfg', 'inf', 'csv', 'xml', 'htm', 'html', 'nfo', 'diz', '1st',
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

function isHlpFile(name: string): boolean {
  return getExt(name) === 'hlp';
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
  if (isHlpFile(name)) return HLP_ICON_32;
  if (isTextFile(name)) return TEXT_ICON_32;
  return GENERIC_ICON_32;
}

/** Return the appropriate 16px icon for a file (file dialog, list views). */
export function fileIcon16(name: string, opts: FileIconOptions = {}): preact.JSX.Element {
  if (opts.isFolder) return FOLDER_ICON_16;
  if (opts.iconUrl) return <img src={opts.iconUrl} width={16} height={16} draggable={false} style={{ imageRendering: 'pixelated' }} />;
  if (isExeByExtension(name)) return EXE_ICON_16;
  if (isHlpFile(name)) return HLP_ICON_16;
  if (isTextFile(name)) return TEXT_ICON_16;
  return GENERIC_ICON_16;
}

// Re-export individual icons for backward compat (Taskbar etc.)
export { FOLDER_ICON_16, EXE_ICON_16, FOLDER_ICON_32, EXE_ICON_32, GENERIC_ICON_32, TEXT_ICON_16, TEXT_ICON_32, HLP_ICON_16, HLP_ICON_32 };
