// Regional settings module — locale presets, keyboard layouts, persistence

// --- Types ---

export interface RegionalSettings {
  localeId: number;        // LCID (0x0409, 0x040C, ...)
  keyboardLayout: string;  // 'qwerty-us', 'azerty-fr'
  decimalSep: string;      // '.' or ','
  thousandsSep: string;    // ',', '.', ' '
  shortDateFmt: string;    // e.g. 'M/d/yyyy' or 'dd/MM/yyyy'
  longDateFmt: string;     // e.g. 'dddd, MMMM dd, yyyy'
  timeFmt: string;         // e.g. 'h:mm:ss tt' or 'HH:mm:ss'
}

export interface LocalePreset {
  localeId: number;
  name: string;            // e.g. 'English (United States)'
  isoTag: string;          // e.g. 'en-US'
  langPrimary: number;     // primary language ID (LCID & 0x3FF)
  /** Native language name (e.g. '한국어'). Optional — only some presets set it. */
  langName?: string;
  /** Native country name (e.g. '대한민국'). Optional. */
  countryName?: string;
  /** Currency symbol — optional metadata. */
  currencySym?: string;
  ansiCodePage: number;
  oemCodePage: number;
  defaultKeyboard: string;
  decimalSep: string;
  thousandsSep: string;
  listSep: string;
  dateSep: string;
  timeSep: string;
  shortDate: string;
  longDate: string;
  timeFormat: string;
  am: string;
  pm: string;
  measure: string;         // '1' = US, '0' = metric
  negOrder: string;        // negative number order
  iDigits: string;         // decimal digits
  iLZero: string;          // leading zero
  grouping: string;        // digit grouping e.g. '3;0'
  iTime: string;           // 0=12hr, 1=24hr
  iTLZero: string;         // time leading zero
  monthNames: string[];    // 12 month names (January..December)
  monthAbbr: string[];     // 12 abbreviated month names (Jan..Dec)
  dayNames: string[];      // 7 day names starting Monday (Monday..Sunday)
  dayAbbr: string[];       // 7 abbreviated day names starting Monday (Mon..Sun)
}

export interface KeyboardLayoutDef {
  id: string;
  name: string;
  hkl: number;             // HKL value for GetKeyboardLayout
  codeToVK: Record<string, number>;
  // char → { vk, shift } for VkKeyScan / MapVirtualKey MAPVK_VK_TO_CHAR
  charToVK: Map<string, { vk: number; shift: boolean }>;
}

// --- VK constants ---

const VK_A = 0x41, VK_B = 0x42, VK_C = 0x43, VK_D = 0x44, VK_E = 0x45, VK_F = 0x46;
const VK_G = 0x47, VK_H = 0x48, VK_I = 0x49, VK_J = 0x4A, VK_K = 0x4B, VK_L = 0x4C;
const VK_M = 0x4D, VK_N = 0x4E, VK_O = 0x4F, VK_P = 0x50, VK_Q = 0x51, VK_R = 0x52;
const VK_S = 0x53, VK_T = 0x54, VK_U = 0x55, VK_V = 0x56, VK_W = 0x57, VK_X = 0x58;
const VK_Y = 0x59, VK_Z = 0x5A;

const VK_OEM_1 = 0xBA;      // ;:
const VK_OEM_PLUS = 0xBB;   // =+
const VK_OEM_COMMA = 0xBC;  // ,<
const VK_OEM_MINUS = 0xBD;  // -_
const VK_OEM_PERIOD = 0xBE; // .>
const VK_OEM_2 = 0xBF;      // /?
const VK_OEM_3 = 0xC0;      // `~
const VK_OEM_4 = 0xDB;      // [{
const VK_OEM_5 = 0xDC;      // \|
const VK_OEM_6 = 0xDD;      // ]}
const VK_OEM_7 = 0xDE;      // '"
const VK_OEM_8 = 0xDF;      // !§ (French)
const VK_OEM_102 = 0xE2;    // <> key (ISO keyboards)

// --- Shared non-letter keys ---

const sharedKeys: Record<string, number> = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, ShiftLeft: 0x10, ShiftRight: 0x10,
  ControlLeft: 0x11, ControlRight: 0x11, AltLeft: 0x12, AltRight: 0x12,
  Pause: 0x13, CapsLock: 0x14, Escape: 0x1B, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  PrintScreen: 0x2C, Insert: 0x2D, Delete: 0x2E,
  Digit0: 0x30, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34,
  Digit5: 0x35, Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7A, F12: 0x7B,
  NumLock: 0x90, ScrollLock: 0x91,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6A, NumpadAdd: 0x6B, NumpadSubtract: 0x6D,
  NumpadDecimal: 0x6E, NumpadDivide: 0x6F, NumpadEnter: 0x0D,
};

// --- QWERTY US layout ---

const qwertyLetters: Record<string, number> = {
  KeyA: VK_A, KeyB: VK_B, KeyC: VK_C, KeyD: VK_D, KeyE: VK_E, KeyF: VK_F,
  KeyG: VK_G, KeyH: VK_H, KeyI: VK_I, KeyJ: VK_J, KeyK: VK_K, KeyL: VK_L,
  KeyM: VK_M, KeyN: VK_N, KeyO: VK_O, KeyP: VK_P, KeyQ: VK_Q, KeyR: VK_R,
  KeyS: VK_S, KeyT: VK_T, KeyU: VK_U, KeyV: VK_V, KeyW: VK_W, KeyX: VK_X,
  KeyY: VK_Y, KeyZ: VK_Z,
};

const qwertyPunct: Record<string, number> = {
  Semicolon: VK_OEM_1, Equal: VK_OEM_PLUS, Comma: VK_OEM_COMMA, Minus: VK_OEM_MINUS,
  Period: VK_OEM_PERIOD, Slash: VK_OEM_2, Backquote: VK_OEM_3,
  BracketLeft: VK_OEM_4, Backslash: VK_OEM_5, BracketRight: VK_OEM_6, Quote: VK_OEM_7,
};

function buildCharToVK(entries: Array<[string, number, boolean]>): Map<string, { vk: number; shift: boolean }> {
  const m = new Map<string, { vk: number; shift: boolean }>();
  for (const [ch, vk, shift] of entries) m.set(ch, { vk, shift });
  return m;
}

const qwertyUsCharMap = buildCharToVK([
  // Letters unshifted
  ['a', VK_A, false], ['b', VK_B, false], ['c', VK_C, false], ['d', VK_D, false],
  ['e', VK_E, false], ['f', VK_F, false], ['g', VK_G, false], ['h', VK_H, false],
  ['i', VK_I, false], ['j', VK_J, false], ['k', VK_K, false], ['l', VK_L, false],
  ['m', VK_M, false], ['n', VK_N, false], ['o', VK_O, false], ['p', VK_P, false],
  ['q', VK_Q, false], ['r', VK_R, false], ['s', VK_S, false], ['t', VK_T, false],
  ['u', VK_U, false], ['v', VK_V, false], ['w', VK_W, false], ['x', VK_X, false],
  ['y', VK_Y, false], ['z', VK_Z, false],
  // Letters shifted
  ['A', VK_A, true], ['B', VK_B, true], ['C', VK_C, true], ['D', VK_D, true],
  ['E', VK_E, true], ['F', VK_F, true], ['G', VK_G, true], ['H', VK_H, true],
  ['I', VK_I, true], ['J', VK_J, true], ['K', VK_K, true], ['L', VK_L, true],
  ['M', VK_M, true], ['N', VK_N, true], ['O', VK_O, true], ['P', VK_P, true],
  ['Q', VK_Q, true], ['R', VK_R, true], ['S', VK_S, true], ['T', VK_T, true],
  ['U', VK_U, true], ['V', VK_V, true], ['W', VK_W, true], ['X', VK_X, true],
  ['Y', VK_Y, true], ['Z', VK_Z, true],
  // Digits
  ['0', 0x30, false], ['1', 0x31, false], ['2', 0x32, false], ['3', 0x33, false],
  ['4', 0x34, false], ['5', 0x35, false], ['6', 0x36, false], ['7', 0x37, false],
  ['8', 0x38, false], ['9', 0x39, false],
  // Punct unshifted
  [';', VK_OEM_1, false], ['=', VK_OEM_PLUS, false], [',', VK_OEM_COMMA, false],
  ['-', VK_OEM_MINUS, false], ['.', VK_OEM_PERIOD, false], ['/', VK_OEM_2, false],
  ['`', VK_OEM_3, false], ['[', VK_OEM_4, false], ['\\', VK_OEM_5, false],
  [']', VK_OEM_6, false], ["'", VK_OEM_7, false],
  // Punct shifted
  [':', VK_OEM_1, true], ['+', VK_OEM_PLUS, true], ['<', VK_OEM_COMMA, true],
  ['_', VK_OEM_MINUS, true], ['>', VK_OEM_PERIOD, true], ['?', VK_OEM_2, true],
  ['~', VK_OEM_3, true], ['{', VK_OEM_4, true], ['|', VK_OEM_5, true],
  ['}', VK_OEM_6, true], ['"', VK_OEM_7, true],
  ['!', 0x31, true], ['@', 0x32, true], ['#', 0x33, true], ['$', 0x34, true],
  ['%', 0x35, true], ['^', 0x36, true], ['&', 0x37, true], ['*', 0x38, true],
  ['(', 0x39, true], [')', 0x30, true],
  [' ', 0x20, false],
]);

// --- AZERTY FR layout ---
// Physical key positions map to different VK codes on AZERTY

const azertyLetters: Record<string, number> = {
  KeyA: VK_Q, KeyB: VK_B, KeyC: VK_C, KeyD: VK_D, KeyE: VK_E, KeyF: VK_F,
  KeyG: VK_G, KeyH: VK_H, KeyI: VK_I, KeyJ: VK_J, KeyK: VK_K, KeyL: VK_L,
  KeyM: VK_OEM_COMMA, // M key on AZERTY is where comma is on QWERTY
  KeyN: VK_N, KeyO: VK_O, KeyP: VK_P,
  KeyQ: VK_A,  // Physical Q → VK_A
  KeyR: VK_R, KeyS: VK_S, KeyT: VK_T, KeyU: VK_U, KeyV: VK_V,
  KeyW: VK_Z,  // Physical W → VK_Z
  KeyX: VK_X, KeyY: VK_Y,
  KeyZ: VK_W,  // Physical Z → VK_W
};

const azertyPunct: Record<string, number> = {
  Semicolon: VK_M,          // Physical ; → VK_M on AZERTY
  Equal: VK_OEM_PLUS, Comma: VK_OEM_1, Minus: VK_OEM_6,
  Period: VK_OEM_PERIOD, Slash: VK_OEM_8,
  Backquote: VK_OEM_7,
  BracketLeft: VK_OEM_4, Backslash: VK_OEM_5, BracketRight: VK_OEM_6, Quote: VK_OEM_3,
  IntlBackslash: VK_OEM_102,
};

const azertyFrCharMap = buildCharToVK([
  // Letters unshifted (AZERTY layout)
  ['a', VK_A, false], ['b', VK_B, false], ['c', VK_C, false], ['d', VK_D, false],
  ['e', VK_E, false], ['f', VK_F, false], ['g', VK_G, false], ['h', VK_H, false],
  ['i', VK_I, false], ['j', VK_J, false], ['k', VK_K, false], ['l', VK_L, false],
  ['m', VK_M, false], ['n', VK_N, false], ['o', VK_O, false], ['p', VK_P, false],
  ['q', VK_Q, false], ['r', VK_R, false], ['s', VK_S, false], ['t', VK_T, false],
  ['u', VK_U, false], ['v', VK_V, false], ['w', VK_W, false], ['x', VK_X, false],
  ['y', VK_Y, false], ['z', VK_Z, false],
  ['A', VK_A, true], ['B', VK_B, true], ['C', VK_C, true], ['D', VK_D, true],
  ['E', VK_E, true], ['F', VK_F, true], ['G', VK_G, true], ['H', VK_H, true],
  ['I', VK_I, true], ['J', VK_J, true], ['K', VK_K, true], ['L', VK_L, true],
  ['M', VK_M, true], ['N', VK_N, true], ['O', VK_O, true], ['P', VK_P, true],
  ['Q', VK_Q, true], ['R', VK_R, true], ['S', VK_S, true], ['T', VK_T, true],
  ['U', VK_U, true], ['V', VK_V, true], ['W', VK_W, true], ['X', VK_X, true],
  ['Y', VK_Y, true], ['Z', VK_Z, true],
  // Digits (shifted on AZERTY to get numbers)
  ['0', 0x30, true], ['1', 0x31, true], ['2', 0x32, true], ['3', 0x33, true],
  ['4', 0x34, true], ['5', 0x35, true], ['6', 0x36, true], ['7', 0x37, true],
  ['8', 0x38, true], ['9', 0x39, true],
  // Common punctuation
  [',', VK_OEM_COMMA, false], ['.', VK_OEM_PERIOD, false],
  [';', VK_OEM_1, false], [':', VK_OEM_PERIOD, true],
  ['!', VK_OEM_8, false], [' ', 0x20, false],
]);

// --- QWERTZ DE layout ---
// German layout: Y and Z are swapped

const qwertzLetters: Record<string, number> = {
  ...qwertyLetters,
  KeyY: VK_Z,  // Physical Y → VK_Z
  KeyZ: VK_Y,  // Physical Z → VK_Y
};

const qwertzPunct: Record<string, number> = {
  Semicolon: VK_OEM_3, Equal: VK_OEM_6, Comma: VK_OEM_COMMA, Minus: VK_OEM_2,
  Period: VK_OEM_PERIOD, Slash: VK_OEM_MINUS,
  Backquote: VK_OEM_5,
  BracketLeft: VK_OEM_4, Backslash: VK_OEM_7, BracketRight: VK_OEM_PLUS, Quote: VK_OEM_1,
  IntlBackslash: VK_OEM_102,
};

const qwertzDeCharMap = buildCharToVK([
  // Letters (same as QWERTY except Y/Z swap)
  ['a', VK_A, false], ['b', VK_B, false], ['c', VK_C, false], ['d', VK_D, false],
  ['e', VK_E, false], ['f', VK_F, false], ['g', VK_G, false], ['h', VK_H, false],
  ['i', VK_I, false], ['j', VK_J, false], ['k', VK_K, false], ['l', VK_L, false],
  ['m', VK_M, false], ['n', VK_N, false], ['o', VK_O, false], ['p', VK_P, false],
  ['q', VK_Q, false], ['r', VK_R, false], ['s', VK_S, false], ['t', VK_T, false],
  ['u', VK_U, false], ['v', VK_V, false], ['w', VK_W, false], ['x', VK_X, false],
  ['y', VK_Y, false], ['z', VK_Z, false],
  ['A', VK_A, true], ['B', VK_B, true], ['C', VK_C, true], ['D', VK_D, true],
  ['E', VK_E, true], ['F', VK_F, true], ['G', VK_G, true], ['H', VK_H, true],
  ['I', VK_I, true], ['J', VK_J, true], ['K', VK_K, true], ['L', VK_L, true],
  ['M', VK_M, true], ['N', VK_N, true], ['O', VK_O, true], ['P', VK_P, true],
  ['Q', VK_Q, true], ['R', VK_R, true], ['S', VK_S, true], ['T', VK_T, true],
  ['U', VK_U, true], ['V', VK_V, true], ['W', VK_W, true], ['X', VK_X, true],
  ['Y', VK_Y, true], ['Z', VK_Z, true],
  ['0', 0x30, false], ['1', 0x31, false], ['2', 0x32, false], ['3', 0x33, false],
  ['4', 0x34, false], ['5', 0x35, false], ['6', 0x36, false], ['7', 0x37, false],
  ['8', 0x38, false], ['9', 0x39, false],
  [',', VK_OEM_COMMA, false], ['.', VK_OEM_PERIOD, false],
  ['-', VK_OEM_MINUS, false], ['+', VK_OEM_PLUS, false],
  [' ', 0x20, false],
]);

// --- Keyboard layout definitions ---

const KEYBOARD_LAYOUTS: KeyboardLayoutDef[] = [
  {
    id: 'qwerty-us',
    name: 'QWERTY (US)',
    hkl: 0x04090409,
    codeToVK: { ...sharedKeys, ...qwertyLetters, ...qwertyPunct },
    charToVK: qwertyUsCharMap,
  },
  {
    id: 'azerty-fr',
    name: 'AZERTY (FR)',
    hkl: 0x040C040C,
    codeToVK: { ...sharedKeys, ...azertyLetters, ...azertyPunct },
    charToVK: azertyFrCharMap,
  },
  {
    id: 'qwertz-de',
    name: 'QWERTZ (DE)',
    hkl: 0x04070407,
    codeToVK: { ...sharedKeys, ...qwertzLetters, ...qwertzPunct },
    charToVK: qwertzDeCharMap,
  },
  {
    id: 'qwerty-es',
    name: 'QWERTY (ES)',
    hkl: 0x0C0A0C0A,
    codeToVK: { ...sharedKeys, ...qwertyLetters, ...qwertyPunct },
    charToVK: qwertyUsCharMap,
  },
  {
    id: 'qwerty-jp',
    name: 'QWERTY (JP)',
    hkl: 0x04110411,
    codeToVK: { ...sharedKeys, ...qwertyLetters, ...qwertyPunct },
    charToVK: qwertyUsCharMap,
  },
];

// --- Locale presets ---

const LOCALE_PRESETS: LocalePreset[] = [
  {
    localeId: 0x0409,
    name: 'English (United States)',
    isoTag: 'en-US',
    langPrimary: 0x09,
    ansiCodePage: 1252,
    oemCodePage: 437,
    defaultKeyboard: 'qwerty-us',
    decimalSep: '.',
    thousandsSep: ',',
    listSep: ',',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'M/d/yyyy',
    longDate: 'dddd, MMMM dd, yyyy',
    timeFormat: 'h:mm:ss tt',
    am: 'AM',
    pm: 'PM',
    measure: '1',     // US
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '0',        // 12hr
    iTLZero: '1',
    monthNames: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    monthAbbr: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
    dayNames: ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'],
    dayAbbr: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
  },
  {
    localeId: 0x040C,
    name: 'French (France)',
    isoTag: 'fr-FR',
    langPrimary: 0x0C,
    ansiCodePage: 1252,
    oemCodePage: 850,
    defaultKeyboard: 'azerty-fr',
    decimalSep: ',',
    thousandsSep: '\u00A0',  // non-breaking space
    listSep: ';',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'dd/MM/yyyy',
    longDate: 'dddd d MMMM yyyy',
    timeFormat: 'HH:mm:ss',
    am: '',
    pm: '',
    measure: '0',     // metric
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',        // 24hr
    iTLZero: '1',
    monthNames: ['janvier','f\u00e9vrier','mars','avril','mai','juin','juillet','ao\u00fbt','septembre','octobre','novembre','d\u00e9cembre'],
    monthAbbr: ['janv.','f\u00e9vr.','mars','avr.','mai','juin','juil.','ao\u00fbt','sept.','oct.','nov.','d\u00e9c.'],
    dayNames: ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'],
    dayAbbr: ['lun.','mar.','mer.','jeu.','ven.','sam.','dim.'],
  },
  {
    localeId: 0x0407,
    name: 'German (Germany)',
    isoTag: 'de-DE',
    langPrimary: 0x07,
    ansiCodePage: 1252,
    oemCodePage: 850,
    defaultKeyboard: 'qwertz-de',
    decimalSep: ',',
    thousandsSep: '.',
    listSep: ';',
    dateSep: '.',
    timeSep: ':',
    shortDate: 'dd.MM.yyyy',
    longDate: 'dddd, d. MMMM yyyy',
    timeFormat: 'HH:mm:ss',
    am: '',
    pm: '',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '1',
    monthNames: ['Januar','Februar','M\u00e4rz','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
    monthAbbr: ['Jan','Feb','Mrz','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'],
    dayNames: ['Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag','Sonntag'],
    dayAbbr: ['Mo','Di','Mi','Do','Fr','Sa','So'],
  },
  {
    localeId: 0x0C0A,
    name: 'Spanish (Spain)',
    isoTag: 'es-ES',
    langPrimary: 0x0A,
    ansiCodePage: 1252,
    oemCodePage: 850,
    defaultKeyboard: 'qwerty-es',
    decimalSep: ',',
    thousandsSep: '.',
    listSep: ';',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'dd/MM/yyyy',
    longDate: 'dddd, d\' de \'MMMM\' de \'yyyy',
    timeFormat: 'H:mm:ss',
    am: '',
    pm: '',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '0',
    monthNames: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
    monthAbbr: ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'],
    dayNames: ['lunes','martes','mi\u00e9rcoles','jueves','viernes','s\u00e1bado','domingo'],
    dayAbbr: ['lun','mar','mi\u00e9','jue','vie','s\u00e1b','dom'],
  },
  {
    localeId: 0x0411,
    name: 'Japanese',
    isoTag: 'ja-JP',
    langPrimary: 0x11,
    ansiCodePage: 932,
    oemCodePage: 932,
    defaultKeyboard: 'qwerty-jp',
    decimalSep: '.',
    thousandsSep: ',',
    listSep: ',',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'yyyy/MM/dd',
    longDate: 'yyyy\'\u5e74\'M\'\u6708\'d\'\u65e5\'',
    timeFormat: 'H:mm:ss',
    am: '\u5348\u524d',
    pm: '\u5348\u5f8c',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '0',
    monthNames: ['1\u6708','2\u6708','3\u6708','4\u6708','5\u6708','6\u6708','7\u6708','8\u6708','9\u6708','10\u6708','11\u6708','12\u6708'],
    monthAbbr: ['1','2','3','4','5','6','7','8','9','10','11','12'],
    dayNames: ['\u6708\u66dc\u65e5','\u706b\u66dc\u65e5','\u6c34\u66dc\u65e5','\u6728\u66dc\u65e5','\u91d1\u66dc\u65e5','\u571f\u66dc\u65e5','\u65e5\u66dc\u65e5'],
    dayAbbr: ['\u6708','\u706b','\u6c34','\u6728','\u91d1','\u571f','\u65e5'],
  },
  {
    localeId: 0x0804,
    name: 'Chinese (Simplified)',
    isoTag: 'zh-CN',
    langPrimary: 0x04,
    ansiCodePage: 936,
    oemCodePage: 936,
    defaultKeyboard: 'qwerty-us',
    decimalSep: '.',
    thousandsSep: ',',
    listSep: ',',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'yyyy/M/d',
    longDate: 'yyyy\'\u5e74\'M\'\u6708\'d\'\u65e5\'',
    timeFormat: 'H:mm:ss',
    am: '\u4e0a\u5348',
    pm: '\u4e0b\u5348',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '0',
    monthNames: ['\u4e00\u6708','\u4e8c\u6708','\u4e09\u6708','\u56db\u6708','\u4e94\u6708','\u516d\u6708','\u4e03\u6708','\u516b\u6708','\u4e5d\u6708','\u5341\u6708','\u5341\u4e00\u6708','\u5341\u4e8c\u6708'],
    monthAbbr: ['1','2','3','4','5','6','7','8','9','10','11','12'],
    dayNames: ['\u661f\u671f\u4e00','\u661f\u671f\u4e8c','\u661f\u671f\u4e09','\u661f\u671f\u56db','\u661f\u671f\u4e94','\u661f\u671f\u516d','\u661f\u671f\u65e5'],
    dayAbbr: ['\u4e00','\u4e8c','\u4e09','\u56db','\u4e94','\u516d','\u65e5'],
  },
  {
    localeId: 0x0416,
    name: 'Portuguese (Brazil)',
    isoTag: 'pt-BR',
    langPrimary: 0x16,
    ansiCodePage: 1252,
    oemCodePage: 850,
    defaultKeyboard: 'qwerty-us',
    decimalSep: ',',
    thousandsSep: '.',
    listSep: ';',
    dateSep: '/',
    timeSep: ':',
    shortDate: 'dd/MM/yyyy',
    longDate: 'dddd, d\' de \'MMMM\' de \'yyyy',
    timeFormat: 'HH:mm:ss',
    am: '',
    pm: '',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '1',
    monthNames: ['janeiro','fevereiro','mar\u00e7o','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'],
    monthAbbr: ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'],
    dayNames: ['segunda-feira','ter\u00e7a-feira','quarta-feira','quinta-feira','sexta-feira','s\u00e1bado','domingo'],
    dayAbbr: ['seg','ter','qua','qui','sex','s\u00e1b','dom'],
  },
  {
    localeId: 0x0410,
    name: 'Italian (Italy)',
    isoTag: 'it-IT',
    langPrimary: 0x10,
    ansiCodePage: 1252,
    oemCodePage: 850,
    defaultKeyboard: 'qwerty-us',
    decimalSep: ',',
    thousandsSep: '.',
    listSep: ';',
    dateSep: '/',
    timeSep: '.',
    shortDate: 'dd/MM/yyyy',
    longDate: 'dddd d MMMM yyyy',
    timeFormat: 'H.mm.ss',
    am: '',
    pm: '',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '0',
    monthNames: ['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'],
    monthAbbr: ['gen','feb','mar','apr','mag','giu','lug','ago','set','ott','nov','dic'],
    dayNames: ['luned\u00ec','marted\u00ec','mercoled\u00ec','gioved\u00ec','venerd\u00ec','sabato','domenica'],
    dayAbbr: ['lun','mar','mer','gio','ven','sab','dom'],
  },
  {
    localeId: 0x0415,
    name: 'Polish (Poland)',
    isoTag: 'pl-PL',
    langPrimary: 0x15,
    ansiCodePage: 1250,
    oemCodePage: 852,
    defaultKeyboard: 'qwerty-us',
    decimalSep: ',',
    thousandsSep: '\u00A0',
    listSep: ';',
    dateSep: '.',
    timeSep: ':',
    shortDate: 'dd.MM.yyyy',
    longDate: 'd MMMM yyyy',
    timeFormat: 'HH:mm:ss',
    am: '',
    pm: '',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '1',
    iTLZero: '1',
    monthNames: ['stycze\u0144','luty','marzec','kwiecie\u0144','maj','czerwiec','lipiec','sierpie\u0144','wrzesie\u0144','pa\u017adziernik','listopad','grudzie\u0144'],
    monthAbbr: ['sty','lut','mar','kwi','maj','cze','lip','sie','wrz','pa\u017a','lis','gru'],
    dayNames: ['poniedzia\u0142ek','wtorek','\u015broda','czwartek','pi\u0105tek','sobota','niedziela'],
    dayAbbr: ['Pn','Wt','\u015ar','Cz','Pt','So','Nd'],
  },
  {
    localeId: 0x0412,
    name: '\ud55c\uad6d\uc5b4 (\ub300\ud55c\ubbfc\uad6d)',
    isoTag: 'ko-KR',
    langPrimary: 0x12,
    langName: '\ud55c\uad6d\uc5b4',
    countryName: '\ub300\ud55c\ubbfc\uad6d',
    ansiCodePage: 949,
    oemCodePage: 949,
    defaultKeyboard: 'qwerty-us',
    decimalSep: '.',
    thousandsSep: ',',
    currencySym: '\u20a9',
    listSep: ',',
    dateSep: '-',
    timeSep: ':',
    shortDate: 'yyyy-MM-dd',
    longDate: "yyyy'\ub144' M'\uc6d4' d'\uc77c' dddd",
    timeFormat: 'tt h:mm:ss',
    am: '\uc624\uc804',
    pm: '\uc624\ud6c4',
    measure: '0',
    negOrder: '1',
    iDigits: '2',
    iLZero: '1',
    grouping: '3;0',
    iTime: '0',
    iTLZero: '0',
    monthNames: ['1\uc6d4','2\uc6d4','3\uc6d4','4\uc6d4','5\uc6d4','6\uc6d4','7\uc6d4','8\uc6d4','9\uc6d4','10\uc6d4','11\uc6d4','12\uc6d4'],
    monthAbbr: ['1\uc6d4','2\uc6d4','3\uc6d4','4\uc6d4','5\uc6d4','6\uc6d4','7\uc6d4','8\uc6d4','9\uc6d4','10\uc6d4','11\uc6d4','12\uc6d4'],
    dayNames: ['\uc6d4\uc694\uc77c','\ud654\uc694\uc77c','\uc218\uc694\uc77c','\ubaa9\uc694\uc77c','\uae08\uc694\uc77c','\ud1a0\uc694\uc77c','\uc77c\uc694\uc77c'],
    dayAbbr: ['\uc6d4','\ud654','\uc218','\ubaa9','\uae08','\ud1a0','\uc77c'],
  },
];

// --- UI translations (delegated to ui-strings.ts) ---

import { UI_STRINGS, FALLBACK_STRINGS } from './ui-strings';
export type { UiStrings } from './ui-strings';

export function t(): import('./ui-strings').UiStrings {
  const settings = loadSettings();
  const langPrimary = settings.localeId & 0x3FF;
  if (UI_STRINGS[settings.localeId]) return UI_STRINGS[settings.localeId];
  for (const key in UI_STRINGS) {
    if ((parseInt(key) & 0x3FF) === langPrimary) return UI_STRINGS[parseInt(key)];
  }
  return FALLBACK_STRINGS;
}

// --- Public API ---

export function getLocalePresets(): readonly LocalePreset[] {
  return LOCALE_PRESETS;
}

export function getLocalePreset(localeId: number): LocalePreset {
  return LOCALE_PRESETS.find(p => p.localeId === localeId) || LOCALE_PRESETS[0];
}

export function getKeyboardLayouts(): readonly KeyboardLayoutDef[] {
  return KEYBOARD_LAYOUTS;
}

export function getKeyboardLayout(id: string): KeyboardLayoutDef {
  return KEYBOARD_LAYOUTS.find(l => l.id === id) || KEYBOARD_LAYOUTS[0];
}

const STORAGE_KEY = 'retrotick-regional';

let _cachedSettings: RegionalSettings | null = null;

export function settingsFromPreset(preset: LocalePreset): RegionalSettings {
  return {
    localeId: preset.localeId,
    keyboardLayout: preset.defaultKeyboard,
    decimalSep: preset.decimalSep,
    thousandsSep: preset.thousandsSep,
    shortDateFmt: preset.shortDate,
    longDateFmt: preset.longDate,
    timeFmt: preset.timeFormat,
  };
}

function detectDefaults(): RegionalSettings {
  const lang = (typeof navigator !== 'undefined' ? navigator.language : 'en-US').toLowerCase();
  const prefix = lang.split('-')[0];
  const match = LOCALE_PRESETS.find(p => p.isoTag.toLowerCase().startsWith(prefix + '-'));
  return settingsFromPreset(match || LOCALE_PRESETS[0]);
}

export function loadSettings(): RegionalSettings {
  if (_cachedSettings) return _cachedSettings;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const preset = getLocalePreset(parsed.localeId ?? 0x0409);
      _cachedSettings = {
        localeId: parsed.localeId ?? 0x0409,
        keyboardLayout: parsed.keyboardLayout ?? 'qwerty-us',
        decimalSep: parsed.decimalSep ?? '.',
        thousandsSep: parsed.thousandsSep ?? ',',
        shortDateFmt: parsed.shortDateFmt ?? preset.shortDate,
        longDateFmt: parsed.longDateFmt ?? preset.longDate,
        timeFmt: parsed.timeFmt ?? preset.timeFormat,
      };
      return _cachedSettings;
    }
  } catch { /* ignore */ }
  _cachedSettings = detectDefaults();
  return _cachedSettings;
}

export function saveSettings(settings: RegionalSettings): void {
  _cachedSettings = { ...settings };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent('retrotick-settings-changed'));
}

// Listen for settings changes to invalidate cache
if (typeof window !== 'undefined') {
  window.addEventListener('retrotick-settings-changed', () => {
    _cachedSettings = null;
  });
}
