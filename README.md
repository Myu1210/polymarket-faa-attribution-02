# polymarket-faa-attribution-02

Forecast Polymarket FAA outage-attribution Yes prices, 240 minutes ahead,
5 quantiles per minute. Node 22, stdlib only, no network, deterministic.

## Model

- **Median:** last price plus a heavily damped drift-aware shift — the
  median 1-minute move over the last 60 minutes, persisting ~1 h, then the
  median move over the last 240 minutes at half weight, all scaled by 0.1.
  Prices are sticky (88% of 1-minute moves in the practice are exactly 0),
  so the raw median drift is usually 0 and undamped extrapolation
  overshoots badly (drift scale 1.0 scores 0.300 vs 0.274 at 0.1).
- **Spread:** empirical quantiles of the market's own h-minute moves over
  the last 480 prices (8 h). A Gaussian spread wastes width: realised
  moves have a big atom at 0 and heavy jump tails, so the empirical
  quantiles are narrow at the quartiles and wide at the 5%/95% tails. When
  fewer than 20 h-minute move pairs exist, the 1-minute move quantiles are
  scaled by sqrt(h) instead.
- **Volatility regime:** the spread is stretched/shrunk around the median
  by (std of last 60 diffs / std of last 240 diffs)^0.75, clamped to
  [0.5, 2].
- **Short histories** blend toward the persistence baseline
  (x + z·0.0025·sqrt(h)), weight 0.5·(1 − n/1440) while n < 1440 prices.
- **Jump pad:** outer quantiles widened by 0.01·sqrt(h/240); inner
  quartiles pulled 30% toward the median.
- **FAA mutual-exclusivity guard:** only when a case has ≤ 6 markets (the
  real final has 4 attribution markets; practice cases have 19–24, so it
  never fires on practice): if the markets' medians sum above 0.97, the
  excess is scaled down proportionally across markets. Unit-tested with a
  synthetic 4-market case (medians capped at exactly 0.970000 at every
  horizon) and a 7-market case (guard does not fire).
- **Final pass per row:** non-decreasing, clamped to [0, 1], 6 decimals.
  A market with no prices throws an error naming its id.

### Tuned coefficients

| Parameter | Value |
|---|---|
| Lookback for empirical moves | 480 prices |
| Min h-minute move pairs | 20 |
| Drift scale | 0.1 |
| Long-drift weight (after 1 h) | 0.5 |
| Vol power / clamp | 0.75 / [0.5, 2] |
| Short-history weight / cutoff | 0.5 / 1440 |
| Jump pad | 0.01 |
| Inner-quartile pull | 0.7 (keep 70% of distance to median) |
| Baseline spread | 0.0025 |

## Backtest (practice, 6 cases p00–p05)

`grade-local` cannot run for this kit — its scorer/reference are not
published ("graded on the server only") — so the practice was scored with
an independent pinball scorer: pinball = 100·max(τ·(y−q), (τ−1)·(y−q))
averaged over cases/markets/minutes/quantiles. Realised prices for
p00–p04 come from the next case's history (each later case extends the
same grid by 240 minutes); p05's realised prices (2026-11-13 02:01–06:00Z)
were rebuilt from Polymarket's public CLOB price history with the house
grid rule (price at minute m = last point with t ≤ m, forward-filled).
The reconstruction was validated 240/240 exact on the p00 window.
The scorer reproduces the organiser baseline exactly (0.363589) and the
sibling nvidia v1 entry exactly (0.283201), so the comparison is sound.

| Case | This entry | Baseline |
|---|---|---|
| p00 | 0.494128 | 0.536138 |
| p01 | 0.308887 | 0.380352 |
| p02 | 0.349988 | 0.408408 |
| p03 | 0.245483 | 0.368599 |
| p04 | 0.201553 | 0.298794 |
| p05 | 0.113477 | 0.238232 |
| **Overall** | **0.274327** | **0.363589** |

Median error 0.744360, 90% coverage 0.944629. Beats the organiser
baseline (0.363589) by 0.089 and the sibling nvidia v1 (0.283201).

### Tuning history (full-6 practice pinball)

- First version (parametric: drift-aware median + EWMA sigma + Gaussian
  quantiles + jump/bounce): **0.347245** — beats the baseline but the
  Gaussian spread is far too wide (coverage 0.983) and drift/jump
  extrapolation hurts the median. The EWMA sigma over full history is
  inflated by stale jumps; half-life 30 + clamp 0.003 was its best
  (0.3465 on p00–p04).
- Empirical h-minute move quantiles, lookback sweep: 120 → 0.297070,
  240 → 0.283201, **480 → 0.279868**, 600 → 0.284812, 720 → 0.286743.
- Drift scale at lookback 480: 0 → 0.279868, 0.0625 → 0.274635,
  0.125 → 0.274510, 0.2 → 0.277198, 0.25 → 0.278682, 0.375 → 0.282410 —
  a flat optimum around 0.06–0.13, so 0.1 was chosen (round, inside the
  plateau, not a sharp peak). Other knobs were flat around the chosen
  values (vol power, inner pull, jump pad, vol clamps) and were kept at
  the proven values rather than chased.

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

One `<id>.out` per `<id>.in`, JSON `{"forecasts":[{"id":...,"q":[[...] x 240]}]}`.

## Verification

- Two runs byte-identical (determinism).
- All 6 cases in ~1.6 s total (limit 8 s per case).
- Each `.out` < 1 MiB (175–238 KB).
- Output format checked: exactly `{"forecasts":[...]}`, 240 rows × 5
  numbers per market, non-decreasing, in [0, 1], 6 decimals.
- Guard unit test: synthetic 4-market case capped at 0.97; 7-market
  case untouched. Empty-price market throws `market <id> has no prices`.
