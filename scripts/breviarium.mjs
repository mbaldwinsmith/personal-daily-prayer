// Shared fetch/parse helpers for the Breviarium open-source library
// (see SOURCES.md, "Cross-check witness: Breviarium"), used by both
// verify-short-readings-breviarium.mjs (Ordinary Time ferial cross-check)
// and generate-advent-lent-short-readings.mjs (Advent/Lent proper).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = 'https://raw.githubusercontent.com/Breviarium-app/breviarium--core/main/databases';

export async function fetchBreviariumJson(path) {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`Fetch failed ${res.status}: ${path}`);
  return res.json();
}

// Spanish (CEE-style) book abbreviations used in lectura_breve_citas.json,
// mapped to the same full book names used in data/texts/book-abbreviations.json.
const ES_BOOKS = {
  'Gn': 'Genesis', 'Ex': 'Exodus', 'Lv': 'Leviticus', 'Dt': 'Deuteronomy',
  '1 S': 'I Samuel', '2 S': 'II Samuel', '1 R': 'I Kings', '2 Cro': 'II Chronicles',
  'Ne': 'Nehemiah', 'Tb': 'Tobit', 'Jdt': 'Judith', 'Est': 'Esther', 'Jb': 'Job',
  'Pr': 'Proverbs', 'Ct': 'Song of Solomon', 'Sb': 'Wisdom', 'Eclo': 'Sirach',
  'Is': 'Isaiah', 'Jr': 'Jeremiah', 'Lm': 'Lamentations', 'Ba': 'Baruch', 'Ez': 'Ezekiel',
  'Dn': 'Daniel', 'Os': 'Hosea', 'Jl': 'Joel', 'Am': 'Amos', 'Mi': 'Micah', 'So': 'Zephaniah',
  'Ag': 'Haggai', 'Za': 'Zechariah', 'Ml': 'Malachi', 'Hch': 'Acts', 'Rm': 'Romans',
  '1 Co': 'I Corinthians', '2 Co': 'II Corinthians', 'Ga': 'Galatians', 'Ef': 'Ephesians',
  'Flp': 'Philippians', 'Col': 'Colossians', '1 Ts': 'I Thessalonians', '2 Ts': 'II Thessalonians',
  '1 Tm': 'I Timothy', '2 Tm': 'II Timothy', 'Tt': 'Titus', 'Hb': 'Hebrews', 'St': 'James',
  '1 P': 'I Peter', '2 P': 'II Peter', '1 Jn': 'I John', 'Ap': 'Revelation of John',
};

const appAbbreviations = JSON.parse(await readFile(`${ROOT}/data/texts/book-abbreviations.json`, 'utf8'));
const fullNameToAppAbbrev = new Map(Object.entries(appAbbreviations).map(([abbrev, full]) => [full, abbrev]));

export function parseSpanishCitation(raw) {
  const text = raw.trim();
  if (!text) return { error: 'empty' };
  // "(cfr.)"/"(Cfr)" marks the citation itself as an approximate paraphrase, not an exact
  // quote - the source's own signal that resolving it against this app's word-for-word DRC
  // text would misrepresent it, so these are rejected rather than parsed.
  if (/cfr/i.test(text)) return { error: `marked "cfr." (approximate, not exact): ${raw}` };
  const match = text.match(/^((?:[1-3]\s+)?[A-Za-zÁÉÍÓÚÑáéíóúñ]+)\s+(.*)$/);
  if (!match) return { error: `unparseable: ${raw}` };
  const [, rawBookKey, rest] = match;
  const bookKey = rawBookKey.replace(/\s+/g, ' ').trim();
  const fullName = ES_BOOKS[bookKey];
  if (!fullName) return { error: `unknown ES book abbreviation: ${bookKey} (in "${raw}")` };
  const appAbbrev = fullNameToAppAbbrev.get(fullName);
  if (!appAbbrev) return { error: `no app abbreviation for: ${fullName}` };

  const segments = rest.split(/;\s*/).map((seg) => {
    // Spanish sources sometimes use "." rather than "," to separate discontiguous verses
    // within a chapter (e.g. "51.52-53" = verses 51 and 52-53) - normalize to comma first,
    // but only between digits, so book-internal punctuation/annotations are untouched.
    seg = seg.trim().replace(/([0-9])[abc]\b/g, '$1').replace(/(\d)\.(\d)/g, '$1,$2');
    const commaIdx = seg.indexOf(',');
    if (commaIdx === -1) return seg;
    const chapter = seg.slice(0, commaIdx).trim();
    const verseSpec = seg.slice(commaIdx + 1).trim().replace(/\s*,\s*/g, ', ').replace(/\s*-\s*/g, '-');
    return `${chapter}:${verseSpec}`;
  });

  return { citation: `${appAbbrev} ${segments.join(', ')}` };
}
