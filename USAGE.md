# Using the engine

This is the practical reference for [`cartel_engine.ts`](cartel_engine.ts)
how to construct a world, drive it forward, and read the numbers back
out.

---

## Quick start

```ts
import { CartelWorld, GameClock } from "./cartel_engine";

const world = CartelWorld.create();     // 150 cartels, calibrated to 2022
const clock = GameClock.turnBased();    // 1 turn = 1 simulated year

world.setLevers({ enforcement_effort: 1.4, recruitment_prevention: 0.3 });

const flows = world.advanceByWeeks(clock.weeksPerTick);

console.log(world.totalMembers, world.deathsPerWeek, world.isWinning());
```

---

## 1. Build a world

```ts
CartelWorld.create(cartelCount = 150, seed = 7): CartelWorld
```

Generates the synthetic cartel landscape — heavy-tailed sizes (10
"major" cartels holding most members, the rest split among "local"
ones) plus a rivalry network — and calibrates `recruitmentRate`,
`incapacitationCapacity`, `conflictLethality`, and `saturationRate` so
the world starts at the real 2022 anchors (175,000 members, ~371
recruits/week, ~110 arrests/week, ~125 conflict deaths/week).

The **same seed always produces the same world** — use that to give
two players (or two runs) an identical starting landscape for a fair
comparison. Different seeds produce an equally valid but different
cartel layout (the RNG is a small seeded mulberry32, dependency-free).

You can also build a world by hand — pass every field directly to the
constructor instead of calling `create` — useful for tests or a
hand-authored scenario:

```ts
new CartelWorld({
  membersPerCartel,   // number[] or Float64Array, one entry per cartel
  rivalryMatrix,      // flat n*n Float64Array, 1.0 where i and j are rivals
  cartelCount,
  recruitmentRate,           // r — new members per existing member, per week
  incapacitationCapacity,    // h — total arrests per week, split pro-rata by size
  conflictLethality,         // q — deaths per rival-pair-member^2, per week
  saturationRate,            // w — dropouts per member^2, per week
  weeksElapsed,      // optional, default 0
  moneySpentMxnM,    // optional, default 0
  leverValues,       // optional, defaults to each lever's LEVER_SPECS.default
})
```

---

## 2. Set up a clock

The engine has no built-in notion of "a turn" or "a frame" — you tell
it how many simulated weeks to advance, whenever you like.
`GameClock` is a small helper that converts your game's actual time
unit into weeks-per-tick, so you don't do that math yourself:

| Factory | Use for |
|---|---|
| `new GameClock(weeksPerTick)` | Manual control |
| `GameClock.timedRound(secondsPerTick, roundMinutes=5, simulatedYears=2)` | A timed round (e.g. 5 real minutes = 2 simulated years) — countdown-timer games |
| `GameClock.realtime(weeksPerSecond, secondsPerTick)` | Fixed simulated-weeks-per-real-second — continuous/animated play |
| `GameClock.turnBased(weeksPerTurn=52)` | One simulated year per turn (default) — turn-based games |

Whatever you pick, the clock exposes one field — `weeksPerTick` —
that you feed straight into `advanceByWeeks`.

---

## 3. Move the levers

Four policy levers exist, keyed by name in `LEVER_SPECS`:

| Lever name | Range | Default | Annual cost at max (MX$M) | Scales |
|---|---|---|---|---|
| `recruitment_prevention` | 0.0 – 1.0 | 0.0 | 35,000 | `recruitmentRate` ↓ |
| `enforcement_effort` | 0.5 – 1.85 | 1.0 | 102,664 | `incapacitationCapacity` ↑ |
| `conflict_suppression` | 0.0 – 0.20 | 0.0 | 100,000 | `conflictLethality` ↓ |
| `fragmentation_pressure` | 0.0 – 1.0 | 0.0 | 15,000 | `saturationRate` ↑ (deliberately — the only lever that makes a force worse, to encourage fragmentation) |

Set one or more at once — anything you omit keeps its current value.
Values are clamped to `[minimum, maximum]` automatically, so it's safe
to pass out-of-range numbers (e.g. from a raw slider) without checking
first:

```ts
world.setLevers({ conflict_suppression: 0.5 }); // clamped down to 0.20
```

Returns the full current lever map (`LeverValues`). Safe to call
mid-round, as often as you like — the next `advanceByWeeks` call picks
up the new values.

**Check the cost** before (or after) setting levers:

```ts
const cost = world.annualCost();
// { byLever: { recruitment_prevention: 10500, ... },
//   total: 145000,
//   overBudget: false,
//   overBudgetBy: 0 }
```

`total` is compared against `ANNUAL_SECURITY_BUDGET_MXN_M` (MX$190,491M,
Mexico's actual 2024 federal security spending) — `overBudget` is
`true` once `total` exceeds it, and `overBudgetBy` gives the excess.
Nothing stops you from setting levers over budget; the engine just
reports it — enforcing a budget cap is the caller's job.

---

## 4. Advance the simulation

```ts
world.advanceByWeeks(weeksThisTick: number): Flows
```

Integrates the world forward by `weeksThisTick` simulated weeks using
RK4, internally split into ≤1-week substeps so a jump of a year is
just as stable as 52 one-week jumps. You can call this once per
animation frame, once per player turn, or in one big jump — whatever
fits your game loop. It mutates `world` in place (updates
`membersPerCartel`, `weeksElapsed`, `moneySpentMxnM`) and returns the
totals for **this call only**:

```ts
interface Flows {
  recruited: number;        // total new members, this tick
  incapacitated: number;    // total arrested, this tick
  killedByRivals: number;   // total conflict deaths, this tick
  droppedOut: number;       // total natural attrition, this tick
  netChange: number;        // recruited - incapacitated - killedByRivals - droppedOut
}
```

A cartel whose membership drops below `DISBAND_THRESHOLD_MEMBERS` (40)
is zeroed out and effectively dissolves.

For running many ticks at once and keeping a history (e.g. to plot a
whole session after the fact):

```ts
world.runForWeeks(weeks: number, weeksPerTick = 1.0): Array<[number, Flows]>
```

Returns a list of `[weeksElapsedAtThatPoint, flowsForThatTick]` pairs
covering the whole span — equivalent to calling `advanceByWeeks`
repeatedly and recording each result yourself, just less bookkeeping.

---

## 5. Read the results

These are cheap to read after every tick (or every frame, for display):

| Property | Type | Meaning |
|---|---|---|
| `totalMembers` | number | Sum of all cartels' membership right now |
| `survivingCartels` | number | How many cartels still have members > 0 |
| `deathsPerWeek` | number | Conflict deaths *at the current instantaneous rate* (not accumulated — recomputed from current state each time it's read) |
| `weeksElapsed` | number | Total simulated weeks advanced so far |
| `yearsElapsed` | number | `weeksElapsed / 52` |
| `moneySpentMxnM` | number | Cumulative spend, accrued each tick as `annualCost().total * yearsThisTick` |
| `isWinning()` | boolean | `true` iff `totalMembers <= 175,000` **and** `deathsPerWeek <= 125` — i.e. at or below the real 2022 baseline on both fronts |

There is no score beyond `isWinning()` — the intended read-out is a
time series: track `totalMembers` and `deathsPerWeek` (or the `Flows`
returned by each tick) across a run and chart them, which is exactly
what [`web-dashboard/`](web-dashboard/) does.

---

## Worked example: simulate 2 years, print a summary

```ts
import { CartelWorld, WEEKS_PER_YEAR } from "./cartel_engine";

const world = CartelWorld.create();
world.setLevers({ enforcement_effort: 1.6, recruitment_prevention: 0.4 });

const history = world.runForWeeks(2 * WEEKS_PER_YEAR);

console.log(`After ${world.yearsElapsed.toFixed(1)} years:`);
console.log(`  Members:        ${Math.round(world.totalMembers).toLocaleString()}`);
console.log(`  Cartels alive:  ${world.survivingCartels}`);
console.log(`  Deaths/week:    ${world.deathsPerWeek.toFixed(1)}`);
console.log(`  Spent:          MX$${Math.round(world.moneySpentMxnM).toLocaleString()}M`);
console.log(`  Winning?        ${world.isWinning()}`);
```

---

## Reference: exported constants

Everything the engine is calibrated against is an exported constant,
not a magic number buried in a method — override any of them by
constructing a `CartelWorld` by hand (§1) instead of via `create`.

| Constant | Value | Meaning |
|---|---|---|
| `MEMBERS_AT_START` | 175,000 | 2022 baseline membership |
| `RECRUITS_PER_WEEK_AT_START` | 371 | 2022 baseline recruitment |
| `INCAPACITATIONS_PER_WEEK_AT_START` | 110 | 2022 baseline arrests |
| `CONFLICT_DEATHS_PER_WEEK_AT_START` | 125 | 2022 baseline conflict deaths |
| `DISBAND_THRESHOLD_MEMBERS` | 40 | Membership floor before a cartel dissolves |
| `MAX_INTEGRATION_STEP_WEEKS` | 1.0 | RK4 substep ceiling |
| `ANNUAL_SECURITY_BUDGET_MXN_M` | 190,491 | Mexico's actual 2024 federal security spend |
| `DEFAULT_CARTEL_COUNT` | 150 | Cartels generated by `create` |
| `DEFAULT_WORLD_SEED` | 7 | Default RNG seed for `create` |
