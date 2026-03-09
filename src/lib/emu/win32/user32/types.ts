export interface WndClassInfo {
  style: number;
  wndProc: number;
  rawWndProc?: number;
  cbClsExtra: number;
  cbWndExtra: number;
  hInstance: number;
  hIcon: number;
  hCursor: number;
  hbrBackground: number;
  menuName: number;
  className: string;
  /** For superclassed controls: the base built-in class name (e.g. "EDIT" for Delphi's "TEdit") */
  baseClassName?: string;
}

export interface WindowInfo {
  hwnd: number;
  classInfo: WndClassInfo;
  wndProc: number;
  rawWndProc?: number;
  parent: number;
  x: number;
  y: number;
  width: number;
  height: number;
  style: number;
  exStyle: number;
  title: string;
  visible: boolean;
  hMenu: number;
  extraBytes: Uint8Array;
  userData: number;
  children?: Map<number, number>;
  childList?: number[];  // ordered list of child hwnds for GetWindow(GW_CHILD/GW_HWNDNEXT)
  dlgProc?: number;
  controlId?: number;
  needsPaint?: boolean;
  _ownerDrawPending?: boolean;
  _odsSelected?: boolean;
  needsErase?: boolean;
  painting?: boolean;
  minimized?: boolean;
  maximized?: boolean;
  checked?: number;   // BST_UNCHECKED=0, BST_CHECKED=1, BST_INDETERMINATE=2
  hFont?: number;     // font handle set via WM_SETFONT
  props?: Map<string, number>;  // window properties (SetProp/GetProp)
  trackPos?: number;    // trackbar position
  trackMin?: number;    // trackbar range min
  trackMax?: number;    // trackbar range max
  // TreeView state
  treeItems?: Map<number, TreeViewItem>;
  treeNextId?: number;
  treeSelectedItem?: number;
  treeImageList?: number;  // HIMAGELIST handle
  // ListBox state
  lbItems?: string[];
  lbItemData?: number[];
  lbSelectedIndex?: number;       // single-select: current selection (-1 = none)
  lbSelectedIndices?: Set<number>; // multi-select: set of selected indices
  lbTopIndex?: number;             // first visible item index
  lbItemHeight?: number;           // item height in pixels
  // ListView state
  listColumns?: ListViewColumn[];
  listItems?: ListViewItem[];
  // TabControl state
  tabItems?: { text: string }[];
  tabSelectedIndex?: number;
  // StatusBar state
  statusParts?: number[];
  statusTexts?: string[];
  // ComboBox state
  cbItems?: string[];
  cbItemData?: number[];
  cbSelectedIndex?: number;
  // Min track size from WM_GETMINMAXINFO
  minTrackWidth?: number;
  minTrackHeight?: number;
  // Cached heap buffers for LVM_REDRAWITEMS
  _redrawNm?: number;
  _redrawTextBuf?: number;
  // Static control image handle (STM_SETIMAGE)
  hImage?: number;
  // Edit control state
  editSelStart?: number;
  editSelEnd?: number;
  editLimit?: number;     // EM_LIMITTEXT limit (0 = default 30000/32KB)
  editModified?: boolean; // EM_SETMODIFY / EM_GETMODIFY
  editBufferHandle?: number; // EM_GETHANDLE local heap handle
  ownerThreadId?: number; // thread that created this window
  /** Per-control canvas for custom drawing (overlay companion canvas) */
  domCanvas?: HTMLCanvasElement;
  /** DOM input/textarea element for EDIT controls (clipboard operations) */
  domInput?: HTMLTextAreaElement | HTMLInputElement;
  // Scroll bar state (SB_HORZ=0, SB_VERT=1)
  scrollInfo?: { min: number; max: number; pos: number; page: number }[];
}

export interface TreeViewItem {
  id: number;
  parent: number;   // HTREEITEM of parent (0 = root)
  text: string;
  children: number[]; // child HTREEITEM ids
  expanded?: boolean;
  imageIndex?: number;
  selectedImageIndex?: number;
  lParam?: number;
}

export interface ListViewColumn {
  text: string;
  width: number;
  fmt: number;   // alignment
}

export interface ListViewItem {
  text: string;
  subItems?: string[];
  imageIndex?: number;
  lParam?: number;
  state?: number;  // LVIS_SELECTED=1, LVIS_FOCUSED=2, etc.
}
