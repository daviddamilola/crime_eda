/**
 * Cartel engine - the paper's equation, driven by whatever clock your game has.
 *
 * Prieto-Curiel, Campedelli & Hope, Science 381:1312-1316 (2023):
 *
 *     dC_i/dt = r*C_i  -  h*C_i/C  -  q*sum_{j!=i} C_i C_j S_ij  -  w*C_i^2
 *               recruit   incapacit.        conflict               saturation
 *
 * Their one-letter symbols are kept only in this comment; the code spells
 * everything out. Symbol map:
 *
 *     C_i -> membersPerCartel[i]        r -> recruitmentRate
 *     C   -> totalMembers               h -> incapacitationCapacity
 *     S   -> rivalryMatrix              q -> conflictLethality
 *                                        w -> saturationRate
 *
 * There is no fixed window and nothing is keyed off a "level". You call
 * advanceByWeeks() once per tick with however much game-time has passed.
 *
 * Random generation uses a small seeded PRNG (mulberry32), not numpy's
 * PCG64, so a given seed produces a different (but equally valid) cartel
 * landscape than the Python original - the model logic is identical.
 */
// --- units --------------------------------------------------------------
export const WEEKS_PER_YEAR = 52.0;
export const SECONDS_PER_MINUTE = 60.0;
export const NEGLIGIBLE_WEEKS = 1e-9; // loop guard: below this, a tick is finished
// --- 2022 calibration anchors -------------------------------------------
export const MEMBERS_AT_START = 175000; // cartel members in week zero
export const RECRUITS_PER_WEEK_AT_START = 371.0; // 19,300 per year
export const INCAPACITATIONS_PER_WEEK_AT_START = 110.0; // 5,700 per year
export const CONFLICT_DEATHS_PER_WEEK_AT_START = 125.0; // 6,500 per year
export const DROPOUTS_PER_WEEK_AT_START = 2.0; // residual of the flow accounting
// --- how the synthetic cartel landscape is generated --------------------
export const DEFAULT_CARTEL_COUNT = 150; // active cartels the paper identifies
export const MAJOR_CARTEL_COUNT = 10; // the top 10, holding >50% of members
export const CARTEL_SIZE_POWER_LAW_EXPONENT = -1.05; // heavy tail: size ~ rank ** exponent
export const MAJOR_VS_LOCAL_RIVALRY_CHANCE = 0.45; // a big cartel fights a given local one
export const LOCAL_VS_LOCAL_RIVALRY_CHANCE = 0.35; // a local cartel fights a nearby local one
export const LOCAL_RIVALRY_NEIGHBOURHOOD = 4; // how many ranks away "nearby" reaches
export const DEFAULT_WORLD_SEED = 7;
// --- simulation behaviour -----------------------------------------------
export const DISBAND_THRESHOLD_MEMBERS = 40.0; // a cartel smaller than this dissolves
export const MAX_INTEGRATION_STEP_WEEKS = 1.0; // RK4 substep ceiling - keeps long ticks stable
// --- default session shape ----------------------------------------------
export const DEFAULT_ROUND_MINUTES = 5.0; // a round lasts this long in real time
export const DEFAULT_SIMULATED_YEARS = 2.0; // ...and represents this much history
// --- money --------------------------------------------------------------
export const ANNUAL_SECURITY_BUDGET_MXN_M = 190491; // Mexico 2024 federal security function
export const MAX_SATURATION_BOOST = 0.20; // full fragmentation raises saturation 20%
export const LEVER_SPECS = {
    recruitment_prevention: {
        minimum: 0.0, maximum: 1.00, default: 0.0, annualCostAtMaximum: 35000,
        displayName: "Recruitment Prevention", affects: "recruitment_rate (down)",
    },
    enforcement_effort: {
        minimum: 0.5, maximum: 1.85, default: 1.0, annualCostAtMaximum: 102664,
        displayName: "Incapacitate Cartel", affects: "incapacitation_capacity (up)",
    },
    conflict_suppression: {
        minimum: 0.0, maximum: 0.20, default: 0.0, annualCostAtMaximum: 100000,
        displayName: "Conflict Suppression", affects: "conflict_lethality (down)",
    },
    fragmentation_pressure: {
        minimum: 0.0, maximum: 1.00, default: 0.0, annualCostAtMaximum: 15000,
        displayName: "Fragmentation Pressure", affects: "saturation_rate (up)",
    },
};
function defaultLeverValues() {
    const values = {};
    for (const name of Object.keys(LEVER_SPECS))
        values[name] = LEVER_SPECS[name].default;
    return values;
}
/** Seeded PRNG (mulberry32) - deterministic, dependency-free. */
function mulberry32(seed) {
    let state = seed >>> 0;
    return function () {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function matVecMul(matrix, n, vec) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        const row = i * n;
        for (let j = 0; j < n; j++)
            sum += matrix[row + j] * vec[j];
        out[i] = sum;
    }
    return out;
}
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += a[i] * b[i];
    return sum;
}
function sum(arr) {
    let total = 0;
    for (const v of arr)
        total += v;
    return total;
}
/** Translate your game's tick into weeks of simulated time. */
export class GameClock {
    constructor(weeksPerTick = 1.0) {
        this.weeksPerTick = weeksPerTick;
    }
    /** A roundMinutes-long session that plays out simulatedYears of history. */
    static timedRound(secondsPerTick, roundMinutes = DEFAULT_ROUND_MINUTES, simulatedYears = DEFAULT_SIMULATED_YEARS) {
        const roundSeconds = roundMinutes * SECONDS_PER_MINUTE;
        const weeksPerSecond = (simulatedYears * WEEKS_PER_YEAR) / roundSeconds;
        return new GameClock(weeksPerSecond * secondsPerTick);
    }
    static realtime(weeksPerSecond, secondsPerTick) {
        return new GameClock(weeksPerSecond * secondsPerTick);
    }
    static turnBased(weeksPerTurn = WEEKS_PER_YEAR) {
        return new GameClock(weeksPerTurn);
    }
}
export class CartelWorld {
    constructor({ membersPerCartel, rivalryMatrix, cartelCount, recruitmentRate, incapacitationCapacity, conflictLethality, saturationRate, weeksElapsed = 0.0, moneySpentMxnM = 0.0, leverValues, }) {
        this.membersPerCartel = Float64Array.from(membersPerCartel);
        this.rivalryMatrix = rivalryMatrix;
        this.cartelCount = cartelCount;
        this.recruitmentRate = recruitmentRate;
        this.incapacitationCapacity = incapacitationCapacity;
        this.conflictLethality = conflictLethality;
        this.saturationRate = saturationRate;
        this.weeksElapsed = weeksElapsed;
        this.moneySpentMxnM = moneySpentMxnM;
        this.leverValues = leverValues ?? defaultLeverValues();
    }
    // ------------------------------------------------------------- setup
    /** Heavy-tailed cartel sizes plus a rivalry network, calibrated to 2022. */
    static create(cartelCount = DEFAULT_CARTEL_COUNT, seed = DEFAULT_WORLD_SEED) {
        const random = mulberry32(seed);
        const n = cartelCount;
        const relativeSize = new Float64Array(n);
        for (let rank = 1; rank <= n; rank++) {
            relativeSize[rank - 1] = Math.pow(rank, CARTEL_SIZE_POWER_LAW_EXPONENT);
        }
        const relativeSizeTotal = sum(relativeSize);
        const membersPerCartel = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            membersPerCartel[i] = (relativeSize[i] / relativeSizeTotal) * MEMBERS_AT_START;
        }
        const rivalryMatrix = new Float64Array(n * n);
        const makeRivals = (one, other) => {
            rivalryMatrix[one * n + other] = 1.0;
            rivalryMatrix[other * n + one] = 1.0;
        };
        for (let major = 0; major < MAJOR_CARTEL_COUNT; major++) {
            for (let local = MAJOR_CARTEL_COUNT; local < n; local++) {
                if (random() < MAJOR_VS_LOCAL_RIVALRY_CHANCE)
                    makeRivals(major, local);
            }
            for (let otherMajor = major + 1; otherMajor < MAJOR_CARTEL_COUNT; otherMajor++) {
                makeRivals(major, otherMajor);
            }
        }
        for (let local = MAJOR_CARTEL_COUNT; local < n; local++) {
            const neighbourhoodEnd = Math.min(local + 1 + LOCAL_RIVALRY_NEIGHBOURHOOD, n);
            for (let neighbour = local + 1; neighbour < neighbourhoodEnd; neighbour++) {
                if (random() < LOCAL_VS_LOCAL_RIVALRY_CHANCE)
                    makeRivals(local, neighbour);
            }
        }
        const totalMembers = sum(membersPerCartel);
        const rivalContact = matVecMul(rivalryMatrix, n, membersPerCartel);
        const rivalExposure = dot(membersPerCartel, rivalContact);
        let sumSquares = 0;
        for (const m of membersPerCartel)
            sumSquares += m * m;
        return new CartelWorld({
            membersPerCartel,
            rivalryMatrix,
            cartelCount: n,
            recruitmentRate: RECRUITS_PER_WEEK_AT_START / totalMembers,
            incapacitationCapacity: INCAPACITATIONS_PER_WEEK_AT_START,
            conflictLethality: CONFLICT_DEATHS_PER_WEEK_AT_START / rivalExposure,
            saturationRate: DROPOUTS_PER_WEEK_AT_START / sumSquares,
        });
    }
    /** Clamp and apply lever settings. Safe to call mid-round. */
    setLevers(newValues) {
        for (const name of Object.keys(LEVER_SPECS)) {
            if (name in newValues) {
                const spec = LEVER_SPECS[name];
                this.leverValues[name] = Math.min(Math.max(Number(newValues[name]), spec.minimum), spec.maximum);
            }
        }
        return this.leverValues;
    }
    // ------------------------------------------------------------- money
    annualCost() {
        const byLever = {};
        let total = 0;
        for (const name of Object.keys(LEVER_SPECS)) {
            const cost = LEVER_SPECS[name].annualCostAtMaximum * this.leverValues[name];
            byLever[name] = cost;
            total += cost;
        }
        return {
            byLever,
            total,
            overBudget: total > ANNUAL_SECURITY_BUDGET_MXN_M + 0.5,
            overBudgetBy: Math.max(0.0, total - ANNUAL_SECURITY_BUDGET_MXN_M),
        };
    }
    // ------------------------------------------------------------- state
    get totalMembers() {
        return sum(this.membersPerCartel);
    }
    get survivingCartels() {
        let count = 0;
        for (const m of this.membersPerCartel)
            if (m > 0)
                count++;
        return count;
    }
    get deathsPerWeek() {
        const { killedByRivals } = this._flowTerms(this.membersPerCartel);
        return sum(killedByRivals);
    }
    get yearsElapsed() {
        return this.weeksElapsed / WEEKS_PER_YEAR;
    }
    isWinning() {
        return this.totalMembers <= MEMBERS_AT_START && this.deathsPerWeek <= CONFLICT_DEATHS_PER_WEEK_AT_START;
    }
    // ------------------------------------------------------------- model
    /** The four model rates after the player's levers are applied. */
    _effectiveRates() {
        const levers = this.leverValues;
        return {
            recruitmentRate: this.recruitmentRate * (1 - levers.recruitment_prevention),
            incapacitationCapacity: this.incapacitationCapacity * levers.enforcement_effort,
            conflictLethality: this.conflictLethality * (1 - levers.conflict_suppression),
            saturationRate: this.saturationRate * (1 + MAX_SATURATION_BOOST * levers.fragmentation_pressure),
        };
    }
    /** The four terms of the equation, per cartel, in people per week. */
    _flowTerms(membersPerCartel) {
        const n = this.cartelCount;
        const { recruitmentRate, incapacitationCapacity, conflictLethality, saturationRate } = this._effectiveRates();
        const totalMembers = sum(membersPerCartel);
        if (totalMembers <= 0) {
            const zero = new Float64Array(n);
            return { recruited: zero, incapacitated: zero, killedByRivals: zero, droppedOut: zero };
        }
        const recruited = new Float64Array(n);
        const incapacitated = new Float64Array(n);
        const droppedOut = new Float64Array(n);
        const rivalContact = matVecMul(this.rivalryMatrix, n, membersPerCartel);
        const killedByRivals = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            recruited[i] = recruitmentRate * membersPerCartel[i];
            incapacitated[i] = (incapacitationCapacity * membersPerCartel[i]) / totalMembers;
            killedByRivals[i] = conflictLethality * membersPerCartel[i] * rivalContact[i];
            droppedOut[i] = saturationRate * membersPerCartel[i] * membersPerCartel[i];
        }
        return { recruited, incapacitated, killedByRivals, droppedOut };
    }
    _rateOfChange(membersPerCartel) {
        const { recruited, incapacitated, killedByRivals, droppedOut } = this._flowTerms(membersPerCartel);
        const n = this.cartelCount;
        const out = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            out[i] = recruited[i] - incapacitated[i] - killedByRivals[i] - droppedOut[i];
        }
        return out;
    }
    // ------------------------------------------------------------- tick
    /**
     * Integrate forward. Substeps internally, so the caller may pass one
     * frame, one week or one year. Returns the flows during THIS tick.
     */
    advanceByWeeks(weeksThisTick) {
        const n = this.cartelCount;
        const flowsThisTick = { recruited: 0.0, incapacitated: 0.0, killedByRivals: 0.0, droppedOut: 0.0, netChange: 0.0 };
        let weeksRemaining = Number(weeksThisTick);
        const clampNonNegative = (arr) => {
            const out = new Float64Array(n);
            for (let i = 0; i < n; i++)
                out[i] = Math.max(arr[i], 0);
            return out;
        };
        while (weeksRemaining > NEGLIGIBLE_WEEKS) {
            const stepWeeks = Math.min(MAX_INTEGRATION_STEP_WEEKS, weeksRemaining);
            weeksRemaining -= stepWeeks;
            const members = this.membersPerCartel;
            // classic Runge-Kutta 4, clamped so no cartel can go negative
            const slopeAtStart = this._rateOfChange(members);
            const midA = new Float64Array(n);
            for (let i = 0; i < n; i++)
                midA[i] = members[i] + (stepWeeks / 2) * slopeAtStart[i];
            const slopeAtMidA = this._rateOfChange(clampNonNegative(midA));
            const midB = new Float64Array(n);
            for (let i = 0; i < n; i++)
                midB[i] = members[i] + (stepWeeks / 2) * slopeAtMidA[i];
            const slopeAtMidB = this._rateOfChange(clampNonNegative(midB));
            const end = new Float64Array(n);
            for (let i = 0; i < n; i++)
                end[i] = members[i] + stepWeeks * slopeAtMidB[i];
            const slopeAtEnd = this._rateOfChange(clampNonNegative(end));
            const averageSlope = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                averageSlope[i] = (slopeAtStart[i] + 2 * slopeAtMidA[i] + 2 * slopeAtMidB[i] + slopeAtEnd[i]) / 6;
            }
            const nextMembers = new Float64Array(n);
            for (let i = 0; i < n; i++) {
                let value = Math.max(members[i] + stepWeeks * averageSlope[i], 0.0);
                if (value < DISBAND_THRESHOLD_MEMBERS)
                    value = 0.0; // that cartel dissolves
                nextMembers[i] = value;
            }
            this.membersPerCartel = nextMembers;
            const { recruited, incapacitated, killedByRivals, droppedOut } = this._flowTerms(nextMembers);
            flowsThisTick.recruited += sum(recruited) * stepWeeks;
            flowsThisTick.incapacitated += sum(incapacitated) * stepWeeks;
            flowsThisTick.killedByRivals += sum(killedByRivals) * stepWeeks;
            flowsThisTick.droppedOut += sum(droppedOut) * stepWeeks;
            this.weeksElapsed += stepWeeks;
        }
        const yearsThisTick = Number(weeksThisTick) / WEEKS_PER_YEAR;
        this.moneySpentMxnM += this.annualCost().total * yearsThisTick;
        flowsThisTick.netChange =
            flowsThisTick.recruited - flowsThisTick.incapacitated - flowsThisTick.killedByRivals - flowsThisTick.droppedOut;
        return flowsThisTick;
    }
    /** Convenience wrapper: many ticks at once. */
    runForWeeks(weeks, weeksPerTick = MAX_INTEGRATION_STEP_WEEKS) {
        const history = [];
        let weeksLeft = weeks;
        while (weeksLeft > NEGLIGIBLE_WEEKS) {
            const stepWeeks = Math.min(weeksPerTick, weeksLeft);
            weeksLeft -= stepWeeks;
            history.push([this.weeksElapsed + stepWeeks, this.advanceByWeeks(stepWeeks)]);
        }
        return history;
    }
}
//# sourceMappingURL=cartel_engine.js.map