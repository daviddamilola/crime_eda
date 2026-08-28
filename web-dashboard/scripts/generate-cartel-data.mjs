#!/usr/bin/env node
/**
 * Build-time codegen: turns the real 2020 BACRIM cartel network and the
 * 2012-2021 homicide/missing/arrest trend series into a static TS module
 * that cartel_engine.ts imports.
 *
 * Source: Prieto-Curiel, Campedelli & Hope, "Mexican cartels form a network
 * of alliances and rivalries," Dryad (2023), doi:10.5061/dryad.zw3r228d7
 * -> ../../cartel_network/*.csv
 *
 * Run: node scripts/generate-cartel-data.mjs  (or npm run generate:cartel-data)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "cartel_network");
const OUT_FILE = join(__dirname, "..", "src", "cartel_network_data.generated.ts");

// --- tiny RFC4180 CSV parser (handles quoted fields, embedded commas, "" escapes) ---
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function readCsv(name) {
  let text = readFileSync(join(DATA_DIR, name), "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  const rows = parseCsv(text);
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx]])));
}

// --- load ---
const nodes = readCsv("BACRIM2020_Nodes.csv"); // Node,Group,State,ShortName
const rivals = readCsv("BACRIM2020_Rivals.csv"); // Edge,Node,Group,RNode,RGroup,weight
const trends = readCsv("Trends2012_2021.csv"); // YEAR,homicide,missings,arrests
const acledClashes = readCsv("ACLED_Cartel_Clashes_2018_2024.csv"); // event_date,year,cartel_a,cartel_b,fatalities,admin1,location,latitude,longitude

const nodeIds = nodes.map((n) => n.Node);
const indexById = new Map(nodeIds.map((id, i) => [id, i]));
const n = nodeIds.length;

// weighted rivalry S_ij, keyed by raw CSV node order (both directions already
// present in the file; max() makes it robust to any accidental asymmetry)
const rawWeight = new Map();
for (const r of rivals) {
  const i = indexById.get(r.Node);
  const j = indexById.get(r.RNode);
  if (i === undefined || j === undefined) continue;
  const w = Number(r.weight);
  const k1 = `${i},${j}`;
  const k2 = `${j},${i}`;
  rawWeight.set(k1, Math.max(rawWeight.get(k1) ?? 0, w));
  rawWeight.set(k2, Math.max(rawWeight.get(k2) ?? 0, w));
}

// total rivalry weight per cartel: a proxy for cartel size, since the raw
// dataset (unlike the paper's model output) carries no member counts
const degree = new Array(n).fill(0);
for (const [key, w] of rawWeight) {
  const i = Number(key.split(",")[0]);
  degree[i] += w;
}

// rank cartels by descending degree -> index 0 is the most-contested cartel
const order = nodeIds.map((_, i) => i).sort((a, b) => degree[b] - degree[a] || a - b);
const rankOfOriginalIndex = new Array(n);
order.forEach((origIdx, rank) => {
  rankOfOriginalIndex[origIdx] = rank;
});

const rankedNames = order.map((i) => nodes[i].Group);
const rankedShortNames = order.map((i) => nodes[i].ShortName);
const rankedStates = order.map((i) => nodes[i].State);
const rankedDegree = order.map((i) => degree[i]);

const rivalryMatrix = new Array(n * n).fill(0);
for (const [key, w] of rawWeight) {
  const [i, j] = key.split(",").map(Number);
  const ri = rankOfOriginalIndex[i];
  const rj = rankOfOriginalIndex[j];
  rivalryMatrix[ri * n + rj] = w;
}

const trendRows = trends
  .map((t) => ({
    year: Number(t.YEAR),
    homicide: Number(t.homicide),
    missings: Number(t.missings),
    arrests: Number(t.arrests),
  }))
  .sort((a, b) => a.year - b.year);

// --- crosswalk: ACLED's free-text cartel names -> our ranked BACRIM index ---
// ACLED events come from extract_acled_clashes.py's own name normalization
// (see that script), which is independent of and differently formatted from
// BACRIM's Spanish names - this is a second, smaller normalization pass to
// line the two up. Heuristic, not verified entity resolution: a handful of
// ACLED actors (regional/minor gangs) never appear in BACRIM's 150-cartel
// roster at all and are dropped rather than guessed at.
function normalizeCartelName(raw) {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toLowerCase()
    .replace(/^(cartel|cártel)\s+(de\s+|del\s+)?/, "")
    .replace(/^(los|la|las|el)\s+/, "")
    .replace(/[().]/g, "")
    .trim();
}

// ACLED canonical name -> the BACRIM Group name it refers to (only needed
// where ACLED's and BACRIM's naming conventions diverge too far for the
// normalizer above to bridge on its own).
const ACLED_TO_BACRIM_OVERRIDES = {
  "Gulf Cartel (Golfo)": "Cártel del Golfo",
  "La Familia Michoacana": "La Nueva Familia Michoacana",
  "Los Chapitos (Sinaloa)": "Los Chapitos",
  "Los Tlacos": "Los Tlacos (Cartel de la Sierra)",
  "Sinaloa Cartel": "Cártel de Sinaloa",
  "Grupo Elite": "Grupo Élite del CJNG",
  "Fuerza Anti Union": "Fuerza Anti-Unión Tepito",
  Tijuana: "Cártel Tijuana Nueva Generación",
};

const rankedIndexByNormalizedName = new Map();
rankedNames.forEach((name, i) => rankedIndexByNormalizedName.set(normalizeCartelName(name), i));
rankedShortNames.forEach((name, i) => {
  const key = normalizeCartelName(name);
  if (!rankedIndexByNormalizedName.has(key)) rankedIndexByNormalizedName.set(key, i);
});

function resolveAcledCartel(acledName) {
  const override = ACLED_TO_BACRIM_OVERRIDES[acledName];
  return rankedIndexByNormalizedName.get(normalizeCartelName(override ?? acledName));
}

const unmatchedAcledNames = new Set();
const clashEvents = [];
for (const row of acledClashes) {
  const a = resolveAcledCartel(row.cartel_a);
  const b = resolveAcledCartel(row.cartel_b);
  if (a === undefined) unmatchedAcledNames.add(row.cartel_a);
  if (b === undefined) unmatchedAcledNames.add(row.cartel_b);
  if (a === undefined || b === undefined) continue;
  clashEvents.push({
    date: row.event_date,
    a,
    b,
    fatalities: Number(row.fatalities),
    state: row.admin1,
    location: row.location,
    notes: row.notes,
  });
}
clashEvents.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

// --- emit ---
const lines = [];
lines.push("/**");
lines.push(" * GENERATED FILE - do not edit by hand.");
lines.push(" *");
lines.push(" * Source: Prieto-Curiel, Campedelli & Hope, \"Mexican cartels form a network");
lines.push(" * of alliances and rivalries,\" Dryad (2023), doi:10.5061/dryad.zw3r228d7");
lines.push(" * (../../cartel_network/*.csv).");
lines.push(" *");
lines.push(" * Cartels are ordered by descending total rivalry weight - a proxy for");
lines.push(" * cartel size, since the raw dataset carries no member counts. Index 0 is");
lines.push(` * the most-contested cartel (${rankedNames[0]}).`);
lines.push(" *");
lines.push(" * Regenerate with: npm run generate:cartel-data");
lines.push(" */");
lines.push("");
lines.push(`export const CARTEL_COUNT = ${n};`);
lines.push("");
lines.push(`export const CARTEL_NAMES: string[] = ${JSON.stringify(rankedNames)};`);
lines.push("");
lines.push(`export const CARTEL_SHORT_NAMES: string[] = ${JSON.stringify(rankedShortNames)};`);
lines.push("");
lines.push(`export const CARTEL_STATES: string[] = ${JSON.stringify(rankedStates)};`);
lines.push("");
lines.push("/** Sum of rivalry weight per cartel - the ranking key (descending). */");
lines.push(`export const CARTEL_RIVALRY_DEGREE: number[] = ${JSON.stringify(rankedDegree)};`);
lines.push("");
lines.push("/** S_ij: flat n*n, weighted by number of states two cartels fight in. */");
lines.push(`export const CARTEL_RIVALRY_WEIGHTS: number[] = ${JSON.stringify(rivalryMatrix)};`);
lines.push("");
lines.push("export interface CartelTrendRow {");
lines.push("  year: number;");
lines.push("  homicide: number;");
lines.push("  missings: number;");
lines.push("  arrests: number;");
lines.push("}");
lines.push("");
lines.push("/** National totals, 2012-2021 (INEGI/RNPDNO/CNSPEF via the paper's repo). */");
lines.push(`export const CARTEL_TRENDS_2012_2021: CartelTrendRow[] = ${JSON.stringify(trendRows, null, 2)};`);
lines.push("");
lines.push("export interface CartelClashEvent {");
lines.push("  date: string; // YYYY-MM-DD");
lines.push("  a: number; // cartel index (this file's ranking)");
lines.push("  b: number;");
lines.push("  fatalities: number;");
lines.push("  state: string;");
lines.push("  location: string; // town/municipality");
lines.push("  notes: string; // ACLED's event description, for hover detail");
lines.push("}");
lines.push("");
lines.push("/**");
lines.push(" * Real, dated cartel-vs-cartel battle events, 2018-2024 (ACLED, via");
lines.push(" * extract_acled_clashes.py -> cartel_network/ACLED_Cartel_Clashes_2018_2024.csv),");
lines.push(" * kept where both sides resolve to a cartel in this file's roster");
lines.push(` * (${clashEvents.length} of ${acledClashes.length} source events; the rest name a cartel outside BACRIM's`);
lines.push(" * 150-cartel roster and are dropped rather than guessed at).");
lines.push(" */");
lines.push(`export const CARTEL_CLASH_EVENTS: CartelClashEvent[] = ${JSON.stringify(clashEvents, null, 2)};`);
lines.push("");

writeFileSync(OUT_FILE, lines.join("\n"));
console.log(`wrote ${OUT_FILE} (${n} cartels, ${trendRows.length} trend years, ${clashEvents.length} dated clash events)`);
if (unmatchedAcledNames.size > 0) {
  console.log(`  ACLED cartel names not found in BACRIM's roster (dropped): ${[...unmatchedAcledNames].sort().join(", ")}`);
}
