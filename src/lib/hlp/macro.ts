// WinHelp macro parser & dispatcher.
// Supports the common navigation/macro subset (Jump/Popup/ALink/KLink/
// IfThen/etc.) used by typical .HLP files.

export type MacroValue = string | number;

export interface MacroCall {
  name: string;
  args: MacroValue[];
}

/** Parse a macro string into one or more calls (separated by ':'). */
export function parseMacro(s: string): MacroCall[] {
  const out: MacroCall[] = [];
  let i = 0;
  // Skip leading whitespace
  while (i < s.length && /\s/.test(s[i])) i++;
  while (i < s.length) {
    // Read name
    let name = '';
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) name += s[i++];
    if (!name) { i++; continue; }
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i])) i++;
    const args: MacroValue[] = [];
    if (s[i] === '(') {
      i++;
      while (i < s.length && s[i] !== ')') {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') break;
        const ch = s[i];
        if (ch === '`' || ch === "'" || ch === '"') {
          const quoteEnd = ch === '`' ? "'" : ch;
          i++;
          let str = '';
          while (i < s.length && s[i] !== quoteEnd) str += s[i++];
          if (i < s.length) i++;
          args.push(str);
        } else if (ch === '-' || /[0-9]/.test(ch)) {
          let num = '';
          if (ch === '-') { num += ch; i++; }
          while (i < s.length && /[0-9.]/.test(s[i])) num += s[i++];
          args.push(parseFloat(num));
        } else {
          // identifier (e.g. nested macro name)
          let ident = '';
          while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) ident += s[i++];
          // Could be a nested macro call — capture the full thing as a string
          if (s[i] === '(') {
            let depth = 0;
            let extra = '';
            while (i < s.length) {
              const c = s[i++];
              if (c === '(') depth++;
              else if (c === ')') { depth--; if (depth === 0) break; }
              extra += c;
            }
            args.push(`${ident}(${extra})`);
          } else {
            args.push(ident);
          }
        }
        while (i < s.length && /\s/.test(s[i])) i++;
        if (s[i] === ',') i++;
      }
      if (s[i] === ')') i++;
    }
    out.push({ name, args });
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === ':' || s[i] === ';') i++;
    while (i < s.length && /\s/.test(s[i])) i++;
  }
  return out;
}

export interface MacroHost {
  jumpId(file: string, ctx: string, window?: string): void;
  jumpContext(file: string, n: number): void;
  jumpHash(file: string, hash: number, window?: string): void;
  popupId(file: string, ctx: string): void;
  popupContext(file: string, n: number): void;
  popupHash(file: string, hash: number): void;
  back(): void;
  contents(): void;
  search(): void;
  finder(): void;
  history(): void;
  next(): void;
  prev(): void;
  about(): void;
  exit(): void;
  print(): void;
  closeWindow(name: string): void;
  focusWindow(name: string): void;
  testALink(name: string): boolean;
  testKLink(name: string): boolean;
  klink(name: string, type?: number, topic?: string, window?: string): void;
  alink(name: string, type?: number, topic?: string, window?: string): void;
  shellExecute(file: string): void;
  execFile(file: string, args?: string): void;
  annotate(): void;
  bookmarkDefine(): void;
}

export function executeMacros(src: string, host: MacroHost): void {
  const calls = parseMacro(src);
  for (const call of calls) {
    dispatch(call, host);
  }
}

function dispatch(call: MacroCall, host: MacroHost): void {
  const a = call.args;
  const sname = call.name.toLowerCase();
  switch (sname) {
    case 'jumpid':
      host.jumpId(str(a[0]), str(a[1]), str(a[2]));
      break;
    case 'jumpcontext':
      host.jumpContext(str(a[0]), num(a[1]));
      break;
    case 'jumphash':
      host.jumpHash(str(a[0]), num(a[1]), str(a[2]));
      break;
    case 'popupid':
      host.popupId(str(a[0]), str(a[1]));
      break;
    case 'popupcontext':
      host.popupContext(str(a[0]), num(a[1]));
      break;
    case 'popuphash':
      host.popupHash(str(a[0]), num(a[1]));
      break;
    case 'back':       host.back(); break;
    case 'contents':   host.contents(); break;
    case 'search':     host.search(); break;
    case 'finder':     host.finder(); break;
    case 'history':    host.history(); break;
    case 'next':       host.next(); break;
    case 'prev':       host.prev(); break;
    case 'about':      host.about(); break;
    case 'exit':       host.exit(); break;
    case 'print':
    case 'copytopic':
    case 'copydialog': host.print(); break;
    case 'closewindow':host.closeWindow(str(a[0])); break;
    case 'focuswindow':host.focusWindow(str(a[0])); break;
    case 'klink':
    case 'kl':
      host.klink(str(a[0]), num(a[1]), str(a[2]), str(a[3])); break;
    case 'alink':
    case 'al':
      host.alink(str(a[0]), num(a[1]), str(a[2]), str(a[3])); break;
    case 'testalink':
    case 'testal':
      break;
    case 'testklink':
    case 'testkl':
      break;
    case 'shellexecute':
    case 'execprogram': host.shellExecute(str(a[0])); break;
    case 'execfile':   host.execFile(str(a[0]), str(a[1])); break;
    case 'annotate':   host.annotate(); break;
    case 'bookmarkdefine': host.bookmarkDefine(); break;
    case 'ifthen':     applyIfThen(call, host, false); break;
    case 'ifthenelse': applyIfThen(call, host, true); break;
    case 'not':        break;
    case 'browsebuttons':
    case 'createbutton':
    case 'cb':
    case 'destroybutton':
    case 'enablebutton':
    case 'disablebutton':
    case 'changebuttonbinding':
    case 'changeenable':
    case 'menu':
    case 'insertmenu':
    case 'appenditem':
    case 'insertitem':
    case 'deleteitem':
    case 'checkitem':
    case 'uncheckitem':
    case 'resetmenu':
    case 'extinsertitem':
    case 'extinsertmenu':
    case 'positionwindow':
    case 'setcontents':
    case 'setpopupcolor':
    case 'tbpos':
    case 'updatewindow':
    case 'registerroutine':
    case 'macrofileload':
    case 'savemark':
    case 'gotomark':
    case 'ismark':
    case 'isnotmark':
    case 'deletemark':
    case 'noshow':
    case 'flush':
    case 'compare':
    case 'shortcut':
      break; // accept silently
    default:
      console.info('[hlp macro] unhandled:', call.name, call.args);
      break;
  }
}

function applyIfThen(call: MacroCall, host: MacroHost, hasElse: boolean): void {
  // IfThen(cond, thenmacro [, elsemacro])
  const cond = call.args[0];
  const thenMacro = call.args[1];
  const elseMacro = hasElse ? call.args[2] : undefined;
  const truth = evalCondition(cond, host);
  if (truth) {
    if (typeof thenMacro === 'string') executeMacros(thenMacro, host);
  } else if (elseMacro && typeof elseMacro === 'string') {
    executeMacros(elseMacro, host);
  }
}

function evalCondition(v: MacroValue | undefined, host: MacroHost): boolean {
  if (typeof v === 'number') return v !== 0;
  if (typeof v !== 'string') return false;
  // Try to parse as a function call
  const parsed = parseMacro(v);
  if (parsed.length === 0) return v.toLowerCase() === 'true';
  const c = parsed[0];
  switch (c.name.toLowerCase()) {
    case 'not': return !evalCondition(c.args[0] as string, host);
    case 'testalink': return host.testALink(str(c.args[0]));
    case 'testklink': return host.testKLink(str(c.args[0]));
    default: return false;
  }
}

function str(v: MacroValue | undefined): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}
function num(v: MacroValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}
