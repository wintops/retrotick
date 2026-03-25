/**
 * INI file profile store — Map<filename, Map<section, Map<key, value>>>
 * All lookups are case-insensitive.
 */

export class ProfileStore {
  private files = new Map<string, Map<string, Map<string, string>>>();
  onChange?: () => void;

  private normFile(name: string): string {
    // Strip path, lowercase — "C:\WINDOWS\MYAPP.INI" → "myapp.ini"
    const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
    return (slash >= 0 ? name.substring(slash + 1) : name).toLowerCase();
  }

  private normKey(s: string): string {
    return s.toLowerCase();
  }

  private getFile(file: string): Map<string, Map<string, string>> {
    const key = this.normFile(file);
    let f = this.files.get(key);
    if (!f) {
      f = new Map();
      this.files.set(key, f);
    }
    return f;
  }

  private getSection(file: string, section: string): Map<string, string> | undefined {
    const f = this.files.get(this.normFile(file));
    return f?.get(this.normKey(section));
  }

  getString(file: string, section: string, key: string, defaultVal: string): string {
    const sec = this.getSection(file, section);
    if (!sec) return defaultVal;
    return sec.get(this.normKey(key)) ?? defaultVal;
  }

  getInt(file: string, section: string, key: string, defaultVal: number): number {
    const sec = this.getSection(file, section);
    if (!sec) return defaultVal;
    const val = sec.get(this.normKey(key));
    if (val === undefined) return defaultVal;
    const n = parseInt(val, 10);
    return isNaN(n) ? defaultVal : n;
  }

  writeString(file: string, section: string, key: string | null, value: string | null): boolean {
    const f = this.getFile(file);
    const secKey = this.normKey(section);

    if (key === null) {
      // key=NULL → delete entire section
      f.delete(secKey);
      this.onChange?.();
      return true;
    }

    if (value === null) {
      // value=NULL → delete the key
      const sec = f.get(secKey);
      if (sec) {
        sec.delete(this.normKey(key));
        if (sec.size === 0) f.delete(secKey);
      }
      this.onChange?.();
      return true;
    }

    let sec = f.get(secKey);
    if (!sec) {
      sec = new Map();
      f.set(secKey, sec);
    }
    sec.set(this.normKey(key), value);
    this.onChange?.();
    return true;
  }

  /** Return all section names for a file */
  getSectionNames(file: string): string[] {
    const f = this.files.get(this.normFile(file));
    if (!f) return [];
    return Array.from(f.keys());
  }

  /** Return all key=value pairs in a section (keys as stored) */
  getSectionKeys(file: string, section: string): string[] {
    const sec = this.getSection(file, section);
    if (!sec) return [];
    return Array.from(sec.keys());
  }

  // --- Serialization for IndexedDB ---

  serialize(): object {
    const result: Record<string, Record<string, Record<string, string>>> = {};
    for (const [fileName, sections] of this.files) {
      const secObj: Record<string, Record<string, string>> = {};
      for (const [secName, keys] of sections) {
        const keyObj: Record<string, string> = {};
        for (const [k, v] of keys) keyObj[k] = v;
        secObj[secName] = keyObj;
      }
      result[fileName] = secObj;
    }
    return result;
  }

  deserialize(obj: unknown): void {
    this.files.clear();
    if (!obj || typeof obj !== 'object') return;
    for (const [fileName, sections] of Object.entries(obj as Record<string, unknown>)) {
      if (!sections || typeof sections !== 'object') continue;
      const secMap = new Map<string, Map<string, string>>();
      for (const [secName, keys] of Object.entries(sections as Record<string, unknown>)) {
        if (!keys || typeof keys !== 'object') continue;
        const keyMap = new Map<string, string>();
        for (const [k, v] of Object.entries(keys as Record<string, string>)) {
          keyMap.set(k, String(v));
        }
        secMap.set(secName, keyMap);
      }
      this.files.set(fileName, secMap);
    }
  }
}
