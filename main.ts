// polymarket-faa-attribution-02 — forecast Polymarket FAA outage-attribution
// Yes prices, 240 minutes ahead, 5 quantiles per minute.
// Node 22, stdlib only, no network, deterministic.
//
// Model (tuned on the 6 practice cases; see README.md):
// - Median: last price plus a heavily damped drift-aware shift — the median
//   1-minute move over the last 60 minutes, persisting ~1h, then the median
//   move over the last 240 minutes at half weight, all scaled by 0.1.
//   Polymarket prices are sticky (88% of 1-minute moves are exactly 0), so
//   the raw median drift is usually 0 and full extrapolation overshoots.
// - Spread: empirical quantiles of the market's own h-minute moves over the
//   last 480 prices (8h). A Gaussian spread wastes width: realised moves
//   have a big atom at 0 and heavy jump tails, so the empirical quantiles
//   are narrow at the quartiles and wide at the 5%/95% tails. When fewer
//   than 20 h-minute move pairs exist, scale the 1-minute move quantiles
//   by sqrt(h) instead.
// - Volatility regime: stretch/shrink the spread around the median by
//   (std of last 60 diffs / std of last 240 diffs)^0.75, clamped to [0.5, 2].
// - Short histories blend toward the persistence baseline
//   (x + z*0.0025*sqrt(h)), weight 0.5*(1 - n/1440) while n < 1440.
// - Jump pad: widen the outer quantiles by 0.01*sqrt(h/240); pull the inner
//   quartiles 30% toward the median.
// - FAA mutual-exclusivity guard: only when a case has <= 6 markets (the
//   real final has 4 attribution markets; practice cases have 19-24, so it
//   never fires on practice): if the markets' medians sum above 0.97, scale
//   the excess down proportionally across markets.
// - Final pass per row: non-decreasing, clamped to [0, 1], 6 decimals.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const GAUSS = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

// Tuned coefficients (round numbers; grid search on practice, see README).
const LOOKBACK = 480; // prices used for the empirical h-minute moves
const MIN_PAIRS = 20; // h-minute move pairs needed, else scale 1-min moves
const DRIFT_SCALE = 0.1; // damping on the drift-aware median shift
const LONG_DRIFT_WEIGHT = 0.5; // long drift counts half after the first hour
const VOL_POWER = 0.75;
const VOL_LOW = 0.5;
const VOL_HIGH = 2;
const SHORT_WEIGHT = 0.5;
const SHORT_CUTOFF = 1440;
const JUMP_PAD = 0.01;
const INNER_PULL = 0.7; // inner quartiles keep 70% of their distance to median
const BASE_SPREAD = 0.0025;
const MAX_BYTES = 1024 * 1024;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Quantile of a sorted array with linear interpolation between neighbours.
function sortedQuantile(sorted: number[], level: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = level * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function populationStd(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  let total = 0;
  for (const v of values) total += v;
  const mean = total / n;
  let sq = 0;
  for (const v of values) {
    const d = v - mean;
    sq += d * d;
  }
  return Math.sqrt(sq / n);
}

// Enforce non-decreasing, clamp to [0, 1], round to 6 decimals.
function finaliseRow(row: number[]): number[] {
  const out: number[] = [];
  let prev = 0;
  for (const v of row) {
    let c = clamp01(v);
    if (c < prev) c = prev;
    const r = Math.round(c * 1_000_000) / 1_000_000;
    out.push(r);
    prev = r;
  }
  return out;
}

// One market's 240 rows of 5 quantiles.
function forecastMarket(market: any, horizon: number): number[][] {
  const prices: number[] = market.prices;
  if (!prices || prices.length === 0) {
    throw new Error(`market ${market.id} has no prices`);
  }
  const x = prices[prices.length - 1];
  const hist = prices.slice(-LOOKBACK);

  // 1-minute moves of the lookback window, sorted once, as the fallback
  // spread when a horizon has too few h-minute pairs.
  const oneMin: number[] = [];
  for (let i = 1; i < hist.length; i++) oneMin.push(hist[i] - hist[i - 1]);
  oneMin.sort((a, b) => a - b);
  const oneMinQ = LEVELS.map((lv) => sortedQuantile(oneMin, lv));

  // Volatility regime from the full history's 1-minute moves.
  const allDiffs: number[] = [];
  for (let i = 1; i < prices.length; i++) allDiffs.push(prices[i] - prices[i - 1]);
  const stdShort = populationStd(allDiffs.slice(-60));
  const stdLong = populationStd(allDiffs.slice(-240));
  const volRatio =
    stdLong === 0
      ? 1
      : Math.min(VOL_HIGH, Math.max(VOL_LOW, Math.pow(stdShort / stdLong, VOL_POWER)));

  // Blend toward the persistence baseline while the history is short.
  const shortW =
    prices.length < SHORT_CUTOFF
      ? SHORT_WEIGHT * (1 - prices.length / SHORT_CUTOFF)
      : 0;

  // Damped drift-aware median shift per horizon step.
  const shortDrift = medianOf(allDiffs.slice(-60));
  const longDrift = medianOf(allDiffs.slice(-240));
  const shift = (h: number): number =>
    DRIFT_SCALE *
    (shortDrift * Math.min(h, 60) +
      longDrift * Math.max(0, h - 60) * LONG_DRIFT_WEIGHT);

  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    // Empirical quantiles of this horizon's moves in the lookback window.
    let moveQ: number[];
    if (hist.length - h >= MIN_PAIRS) {
      const d: number[] = [];
      for (let i = 0; i + h < hist.length; i++) d.push(hist[i + h] - hist[i]);
      d.sort((a, b) => a - b);
      moveQ = LEVELS.map((lv) => sortedQuantile(d, lv));
    } else {
      const root = Math.sqrt(h);
      moveQ = oneMinQ.map((q) => q * root);
    }
    const medShift = shift(h);
    const medianMove = moveQ[2];
    // Centre the empirical spread on the drift-shifted median, blending
    // with the baseline when the history is short.
    let vals = LEVELS.map((_, k) => {
      let v = x + (moveQ[k] - medianMove) + medShift;
      if (shortW > 0) {
        const base = x + GAUSS[k] * BASE_SPREAD * Math.sqrt(h) + medShift;
        v = (1 - shortW) * v + shortW * base;
      }
      return v;
    });
    // Order + clamp before the volatility stretch (order matters).
    for (let k = 1; k < vals.length; k++) {
      if (vals[k] < vals[k - 1]) vals[k] = vals[k - 1];
    }
    for (let k = 0; k < vals.length; k++) vals[k] = clamp01(vals[k]);
    const median = vals[2];
    for (let k = 0; k < vals.length; k++) {
      vals[k] = median + (vals[k] - median) * volRatio;
    }
    // Jump pad on the outer tails, inner quartiles pulled toward median.
    const g = Math.sqrt(h / horizon);
    vals[0] -= JUMP_PAD * g;
    vals[4] += JUMP_PAD * g;
    vals[1] = median + (vals[1] - median) * INNER_PULL;
    vals[3] = median + (vals[3] - median) * INNER_PULL;
    rows.push(finaliseRow(vals));
  }
  return rows;
}

function forecastCase(parsed: any): { forecasts: { id: string; q: number[][] }[] } {
  const horizon: number = parsed.horizon_minutes;
  const markets: any[] = parsed.markets;
  if (!markets || markets.length === 0) {
    throw new Error(`case ${parsed.case} has no markets`);
  }
  for (const m of markets) {
    if (!m.prices || m.prices.length === 0) {
      throw new Error(`market ${m.id} has no prices`);
    }
  }
  const perMarket = markets.map((m) => forecastMarket(m, horizon));

  // FAA mutual-exclusivity guard (<= 6 markets only): if the medians sum
  // above 0.97, scale the excess down proportionally across markets by
  // shifting each row down by its share of the excess.
  if (markets.length <= 6) {
    for (let h = 0; h < horizon; h++) {
      let sum = 0;
      for (let k = 0; k < perMarket.length; k++) sum += perMarket[k][h][2];
      if (sum > 0.97) {
        const excess = sum - 0.97;
        for (let k = 0; k < perMarket.length; k++) {
          const oldMed = perMarket[k][h][2];
          const delta = excess * (oldMed / sum);
          const row = perMarket[k][h];
          for (let j = 0; j < row.length; j++) row[j] = row[j] - delta;
          perMarket[k][h] = finaliseRow(row);
        }
      }
    }
  }

  return {
    forecasts: markets.map((m, i) => ({ id: m.id, q: perMarket[i] })),
  };
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outputDir, { recursive: true });

  const files = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const id = file.slice(0, -".in".length);
    const parsed = JSON.parse(readFileSync(join(inputDir, file), "utf8"));
    const q = parsed.quantiles;
    const ok =
      Array.isArray(q) &&
      q.length === LEVELS.length &&
      LEVELS.every((lv, i) => q[i] === lv);
    if (!ok) {
      throw new Error(
        `case file ${file} must use quantiles [0.05, 0.25, 0.5, 0.75, 0.95] in order`,
      );
    }
    const text = JSON.stringify(forecastCase(parsed)) + "\n";
    if (Buffer.byteLength(text, "utf8") > MAX_BYTES) {
      throw new Error(`output for case ${id} exceeds 1 MiB`);
    }
    writeFileSync(join(outputDir, `${id}.out`), text);
  }
}

main();
