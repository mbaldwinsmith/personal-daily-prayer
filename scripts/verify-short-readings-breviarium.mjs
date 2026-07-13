#!/usr/bin/env node
// Cross-checks this app's Lauds/Daytime-Prayer/Vespers/First-Vespers short-reading citations
// against the Breviarium open-source library (see SOURCES.md, "Cross-check witness:
// Breviarium"). Where a citation is unambiguously corroborated, flips that shortReading's
// "verified" flag to true in the local data/psalter/*.json files. Never invents or overwrites
// a citation - only ever flips verified:false -> true, and only on an exact match.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import romcal from 'romcal';
import { fetchBreviariumJson as fetchJson, parseSpanishCitation } from './breviarium.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- 1. Build a (season, weekOfSeason, dayOfWeek) -> psalterWeek map, cross-validated
// across several years so we only trust combinations that are stable year to year
// (this reuses the exact season/week-detection logic src/calendar.ts already relies on). ---
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEK_PATTERN = /(\d+)(?:st|nd|rd|th)\s+(?:sunday|week)/i;
const SEASON_KEY = { Advent: 'advent', Lent: 'lent', 'Ordinary Time': 'ordinary_time' };

function buildYearMap(year) {
  const entries = romcal.calendarFor({ year });
  const byDate = new Map(entries.map((e) => [e.moment.slice(0, 10), e]));
  const map = new Map();
  for (const entry of entries) {
    const dateKey = entry.moment.slice(0, 10);
    const seasonKey = SEASON_KEY[entry.data.season.value];
    if (!seasonKey) continue;
    const date = new Date(`${dateKey}T00:00:00Z`);
    const sunday = new Date(date);
    sunday.setUTCDate(date.getUTCDate() - date.getUTCDay());
    let week = null;
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(sunday);
      day.setUTCDate(sunday.getUTCDate() + offset);
      const dayEntry = byDate.get(day.toISOString().slice(0, 10));
      if (!dayEntry || dayEntry.data.season.value !== entry.data.season.value) continue;
      const nameMatch = dayEntry.name.match(WEEK_PATTERN);
      if (nameMatch) { week = Number(nameMatch[1]); break; }
    }
    if (week === null) continue;
    map.set(`${seasonKey}_${week}_${DAYS[date.getUTCDay()]}`, entry.data.meta.psalterWeek.key);
  }
  return map;
}

const YEARS = [2024, 2025, 2026, 2027, 2028, 2029];
const yearMaps = YEARS.map(buildYearMap);
const stablePsalterWeek = new Map(); // key -> psalterWeek, only if every year agrees
const allKeys = new Set(yearMaps.flatMap((m) => [...m.keys()]));
for (const key of allKeys) {
  const values = yearMaps.map((m) => m.get(key)).filter((v) => v !== undefined);
  if (values.length < YEARS.length) continue; // not present every year - skip
  if (new Set(values).size !== 1) continue; // unstable across years - skip
  stablePsalterWeek.set(key, values[0]);
}

// --- 2. Load Breviarium data and cross-check. ---
const citas = await fetchJson('es/commons/lectura_breve_citas.json');
const citasById = new Map(citas.map((c) => [c.id, c.val]));

const HOUR_FILES = {
  lauds: 'all_laudes.json',
  daytimePrayer: 'all_sexta.json', // "dp2" Midday Prayer = Sext, matching the existing divineoffice.org sourcing
  vespers: 'all_vesperae.json',
};

const ID_PATTERN = /^(advent|lent|ordinary_time)_(\d+)_(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/;

const results = { verified: [], mismatched: [], skipped: [] };
// Advent and Lent carry their own PROPER short readings in the real Liturgy of the Hours,
// distinct from the Ordinary Time ferial "complementary psalmody" cycle this app's
// data/psalter/week{N} files represent - confirmed empirically below (Advent/Lent/Ordinary
// Time witnesses for the same psalter-week+day routinely disagree, and it's specifically the
// ordinary_time witness that matches this app's existing ferial citations). So only
// ordinary_time entries are valid witnesses for the ferial files; Advent/Lent are logged
// separately as a discovery for possible future proper-of-seasons work, never compared here.
const seasonalDiscoveries = [];

for (const [hour, file] of Object.entries(HOUR_FILES)) {
  const entries = await fetchJson(file);
  // Group normalized citations by (psalterWeek, dayOfWeek). Multiple ordinary_time witnesses
  // (e.g. ordinary_time_1_friday AND ordinary_time_5_friday both -> psalter week I, Friday)
  // must agree with each other - that's the ferial cycle genuinely repeating every 4 weeks.
  const byTarget = new Map();
  for (const entry of entries) {
    const idMatch = entry.id.match(ID_PATTERN);
    if (!idMatch) continue;
    const [, season, weekStr, day] = idMatch;
    const stableKey = `${season}_${weekStr}_${day}`;
    const psalterWeek = stablePsalterWeek.get(stableKey);
    if (psalterWeek === undefined) continue;

    const rawCitation = citasById.get(entry.lectura_biblica_cita);
    if (rawCitation === undefined) continue;
    const parsed = parseSpanishCitation(rawCitation);

    if (season !== 'ordinary_time') {
      seasonalDiscoveries.push({ hour, season, day, psalterWeek, sourceId: entry.id, ...parsed });
      continue;
    }
    const targetKey = `${psalterWeek}_${day}`;
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, []);
    byTarget.get(targetKey).push({ sourceId: entry.id, raw: rawCitation, ...parsed });
  }

  for (const [targetKey, witnesses] of byTarget) {
    const [psalterWeek, day] = targetKey.split('_');
    const errors = witnesses.filter((w) => w.error);
    if (errors.length) {
      results.skipped.push({ hour, psalterWeek, day, reason: errors.map((e) => e.error).join('; ') });
      continue;
    }
    const distinctCitations = new Set(witnesses.map((w) => w.citation));
    if (distinctCitations.size !== 1) {
      results.skipped.push({ hour, psalterWeek, day, reason: `witnesses disagree: ${[...distinctCitations].join(' / ')}` });
      continue;
    }
    const breviariumCitation = [...distinctCitations][0];

    const dataPath = `${ROOT}/data/psalter/week${psalterWeek}/${day}.json`;
    const dayData = JSON.parse(await readFile(dataPath, 'utf8'));
    const hourData = dayData[hour];
    if (!hourData?.shortReading) {
      results.skipped.push({ hour, psalterWeek, day, reason: 'no local shortReading to compare against' });
      continue;
    }
    if (hourData.shortReading.ref === breviariumCitation) {
      results.verified.push({ hour, psalterWeek, day, citation: breviariumCitation, dataPath, witnesses: witnesses.map((w) => w.sourceId) });
    } else {
      results.mismatched.push({ hour, psalterWeek, day, local: hourData.shortReading.ref, breviarium: breviariumCitation, witnesses: witnesses.map((w) => w.sourceId) });
    }
  }
}

// Note: Sunday First Vespers is intentionally NOT cross-checked here. Breviarium's day-keyed
// model has no separate "first vespers of Sunday" entry - `all_vesperae.json`'s Saturday entry
// is Saturday's OWN Vespers, not Sunday's First Vespers, and conflating the two without a way
// to verify that risks introducing a wrong assignment. Left for future work.

// --- 3. Apply confirmed matches: flip verified:false -> true, nothing else. ---
const byFile = new Map();
for (const v of results.verified) {
  if (!byFile.has(v.dataPath)) byFile.set(v.dataPath, JSON.parse(await readFile(v.dataPath, 'utf8')));
  byFile.get(v.dataPath)[v.hour].shortReading.verified = true;
}
for (const [path, data] of byFile) {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// --- 4. Report. ---
console.log(`Verified (flipped to true): ${results.verified.length}`);
for (const v of results.verified) console.log(`  OK   week${v.psalterWeek} ${v.day} ${v.hour}: "${v.citation}" (Breviarium: ${v.witnesses.join(', ')})`);

console.log(`\nMismatched (left unverified, needs human review): ${results.mismatched.length}`);
for (const m of results.mismatched) console.log(`  DIFF week${m.psalterWeek} ${m.day} ${m.hour}: local="${m.local}" vs Breviarium="${m.breviarium}" (${m.witnesses.join(', ')})`);

console.log(`\nSkipped: ${results.skipped.length}`);
for (const s of results.skipped) console.log(`  SKIP week${s.psalterWeek ?? '?'} ${s.day ?? ''} ${s.hour}: ${s.reason}`);

console.log(`\nAdvent/Lent proper short-reading citations found (not applied here - see scripts/generate-advent-lent-short-readings.mjs): ${seasonalDiscoveries.length}`);
for (const d of seasonalDiscoveries) console.log(`  ${d.season} week${d.psalterWeek} ${d.day} ${d.hour}: ${d.citation ?? d.error} (${d.sourceId})`);
