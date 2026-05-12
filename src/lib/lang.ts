const LANG_MAP: Record<number, string> = {
  0x0000: 'Neutral', 0x007F: 'Invariant',
  0x0409: 'EN-US', 0x0809: 'EN-GB', 0x0C09: 'EN-AU', 0x1009: 'EN-CA', 0x1409: 'EN-NZ',
  0x0407: 'DE-DE', 0x0807: 'DE-CH', 0x0C07: 'DE-AT',
  0x040C: 'FR-FR', 0x080C: 'FR-BE', 0x0C0C: 'FR-CA', 0x100C: 'FR-CH',
  0x0410: 'IT-IT', 0x0810: 'IT-CH',
  0x0C0A: 'ES-ES', 0x080A: 'ES-MX', 0x040A: 'ES',
  0x0416: 'PT-BR', 0x0816: 'PT-PT',
  0x0413: 'NL-NL', 0x0813: 'NL-BE',
  0x041D: 'SV-SE', 0x041F: 'TR-TR',
  0x0415: 'PL-PL', 0x0405: 'CS-CZ', 0x040E: 'HU-HU',
  0x0419: 'RU-RU', 0x0422: 'UK-UA',
  0x0411: 'JA-JP', 0x0412: 'KO-KR',
  0x0804: 'ZH-CN', 0x0404: 'ZH-TW', 0x0C04: 'ZH-HK',
  0x0401: 'AR-SA', 0x040D: 'HE-IL', 0x041E: 'TH-TH', 0x042A: 'VI-VN',
  0x0406: 'DA-DK', 0x040B: 'FI-FI', 0x0408: 'EL-GR', 0x0414: 'NB-NO',
  0x0418: 'RO-RO', 0x041B: 'SK-SK', 0x0424: 'SL-SI', 0x041A: 'HR-HR',
  0x0402: 'BG-BG', 0x0403: 'CA-ES', 0x0421: 'ID-ID', 0x043E: 'MS-MY',
};

export function langName(id: number): string {
  if (LANG_MAP[id]) return LANG_MAP[id];
  return `Lang:0x${id.toString(16).padStart(4, '0')}`;
}

/** Extract the first non-neutral language ID from PE resources. */
export function detectPELanguageId(resources: { entries: { languages: { languageId: number }[] }[] }[] | undefined | null): number | null {
  if (!resources) return null;
  for (const res of resources) {
    for (const entry of res.entries) {
      for (const lang of entry.languages) {
        if (lang.languageId && lang.languageId !== 0x7F) return lang.languageId;
      }
    }
  }
  return null;
}

export function langToHtmlLang(id: number | null | undefined): string | null {
  if (id == null) return null;
  const primary = id & 0x3FF;
  if (primary === 0x11) return 'ja';
  if (primary === 0x12) return 'ko';
  if (primary === 0x04) {
    const sub = (id >> 10) & 0x3F;
    if (sub === 2 || sub === 4) return 'zh-Hans';
    return 'zh-Hant';
  }
  return null;
}
