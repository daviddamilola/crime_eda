import {
  CartelWorld,
  LEVER_SPECS,
  LeverName,
  MEMBERS_AT_START,
  CONFLICT_DEATHS_PER_WEEK_AT_START,
  ANNUAL_SECURITY_BUDGET_MXN_M,
} from "./cartel_engine.js";
import { drawChart } from "./chart.js";

// ------------------------------------------------------------------ session
const ROUND_MINUTES = 2.0; // real time one round lasts
const SIMULATED_YEARS = 10; // history that round represents
const FRAMES_PER_SECOND = 20; // update/redraw rate
const ROUND_SECONDS = ROUND_MINUTES * 60.0;
const WEEKS_PER_SECOND = (SIMULATED_YEARS * 52.0) / ROUND_SECONDS;

const SERIES_YOUR_RUN = "#3987e5";
const SERIES_DO_NOTHING = "#d95926";

const LEVER_ORDER: LeverName[] = [
  "recruitment_prevention",
  "enforcement_effort",
  "conflict_suppression",
  "fragmentation_pressure",
];

function signed(n: number): string {
  const rounded = Math.round(n);
  return (rounded >= 0 ? "+" : "") + rounded.toLocaleString();
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStartNum(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

class Dashboard {
  you = CartelWorld.create();
  ghost = CartelWorld.create();

  running = true;
  elapsedSeconds = 0;

  t: number[] = [0];
  ySize: number[] = [MEMBERS_AT_START];
  gSize: number[] = [MEMBERS_AT_START];
  yDead: number[] = [CONFLICT_DEATHS_PER_WEEK_AT_START];
  gDead: number[] = [CONFLICT_DEATHS_PER_WEEK_AT_START];
  marks: number[] = [];

  chartSize = document.getElementById("chart-size") as HTMLCanvasElement;
  chartDead = document.getElementById("chart-dead") as HTMLCanvasElement;
  titleEl = document.getElementById("title") as HTMLElement;
  subtitleEl = document.getElementById("subtitle") as HTMLElement;
  readoutEl = document.getElementById("readout") as HTMLElement;
  slidersEl = document.getElementById("sliders") as HTMLElement;
  pauseBtn = document.getElementById("btn-pause") as HTMLButtonElement;
  resetBtn = document.getElementById("btn-reset") as HTMLButtonElement;

  sliderInputs = {} as Record<LeverName, HTMLInputElement>;
  sliderValueLabels = {} as Record<LeverName, HTMLElement>;

  constructor() {
    this.buildSliders();
    this.pauseBtn.addEventListener("click", () => this.toggle());
    this.resetBtn.addEventListener("click", () => this.reset());
    window.setInterval(() => this.frame(), 1000 / FRAMES_PER_SECOND);
    this.redraw();
  }

  buildSliders(): void {
    for (const key of LEVER_ORDER) {
      const spec = LEVER_SPECS[key];
      const row = document.createElement("div");
      row.className = "slider-row";

      const label = document.createElement("label");
      const name = document.createElement("span");
      name.textContent = spec.displayName;
      const value = document.createElement("span");
      value.className = "slider-value";
      value.textContent = spec.default.toFixed(2);
      label.append(name, value);

      const input = document.createElement("input");
      input.type = "range";
      input.min = String(spec.minimum);
      input.max = String(spec.maximum);
      input.step = String((spec.maximum - spec.minimum) / 100);
      input.value = String(spec.default);
      input.addEventListener("input", () => {
        const numeric = Number(input.value);
        value.textContent = numeric.toFixed(2);
        this.onLever(key, numeric);
      });

      row.append(label, input);
      this.slidersEl.append(row);
      this.sliderInputs[key] = input;
      this.sliderValueLabels[key] = value;
    }
  }

  resetWorlds(): void {
    this.you = CartelWorld.create();
    this.ghost = CartelWorld.create();
    this.t = [0];
    this.ySize = [MEMBERS_AT_START];
    this.gSize = [MEMBERS_AT_START];
    this.yDead = [CONFLICT_DEATHS_PER_WEEK_AT_START];
    this.gDead = [CONFLICT_DEATHS_PER_WEEK_AT_START];
    this.marks = [];
  }

  onLever(key: LeverName, value: number): void {
    this.you.setLevers({ [key]: value });
    this.marks.push(this.you.weeksElapsed);
  }

  toggle(): void {
    this.running = !this.running;
    this.pauseBtn.textContent = this.running ? "Pause" : "Resume";
  }

  reset(): void {
    this.resetWorlds();
    this.elapsedSeconds = 0;
    this.running = true;
    this.pauseBtn.textContent = "Pause";
    for (const key of LEVER_ORDER) {
      const spec = LEVER_SPECS[key];
      this.sliderInputs[key].value = String(spec.default);
      this.sliderValueLabels[key].textContent = spec.default.toFixed(2);
    }
  }

  frame(): void {
    if (this.running && this.elapsedSeconds < ROUND_SECONDS) {
      const dt = Math.min(1 / FRAMES_PER_SECOND, ROUND_SECONDS - this.elapsedSeconds);
      this.elapsedSeconds += dt;
      this.you.advanceByWeeks(dt * WEEKS_PER_SECOND);
      this.ghost.advanceByWeeks(dt * WEEKS_PER_SECOND);
      this.t.push(this.you.weeksElapsed);
      this.ySize.push(this.you.totalMembers);
      this.gSize.push(this.ghost.totalMembers);
      this.yDead.push(this.you.deathsPerWeek);
      this.gDead.push(this.ghost.deathsPerWeek);
    }
    this.redraw();
  }

  redraw(): void {
    drawChart(this.chartSize, {
      title: "Cartel members",
      t: this.t,
      series: [
        { data: this.gSize, color: SERIES_DO_NOTHING, dashed: true, lineWidth: 2 },
        { data: this.ySize, color: SERIES_YOUR_RUN, lineWidth: 2.4, highlightLast: true },
      ],
      referenceValue: MEMBERS_AT_START,
      referenceLabel: "2022 line — get under it to win",
    });

    drawChart(this.chartDead, {
      title: "Killings per week",
      t: this.t,
      series: [
        { data: this.gDead, color: SERIES_DO_NOTHING, dashed: true, lineWidth: 2 },
        { data: this.yDead, color: SERIES_YOUR_RUN, lineWidth: 2.4, highlightLast: true },
      ],
      referenceValue: CONFLICT_DEATHS_PER_WEEK_AT_START,
      referenceLabel: "2022 line",
      showXLabel: true,
    });

    const remaining = Math.max(0, ROUND_SECONDS - this.elapsedSeconds);
    const minutes = Math.floor(remaining / 60);
    const seconds = Math.floor(remaining % 60);
    const year = 2022 + Math.floor(this.you.weeksElapsed / 52);
    const week = Math.floor(this.you.weeksElapsed % 52) + 1;
    const over = this.elapsedSeconds >= ROUND_SECONDS;
    const won = this.you.isWinning();

    let titleText = `${minutes}:${padStartNum(String(seconds), 2).replace(" ", "0")} · ${year} week ${week}`;
    if (over) titleText += won ? " · YOU CLOSED THE TAP" : " · THE WATER WON";
    this.titleEl.textContent = titleText;
    this.titleEl.style.color = over ? (won ? SERIES_YOUR_RUN : SERIES_DO_NOTHING) : "";

    const gap = this.you.totalMembers - this.ghost.totalMembers;
    const deathGap = this.you.deathsPerWeek - this.ghost.deathsPerWeek;
    this.subtitleEl.textContent =
      `${signed(gap)} members vs. doing nothing · ${signed(deathGap)} killings/wk · ` +
      `MX$${(this.you.moneySpentMxnM / 1000).toFixed(0)} bn spent`;

    const cost = this.you.annualCost();
    const rows: string[] = [pad("BUDGET", 16) + padStartNum("MX$M/yr", 11), "-".repeat(27)];
    for (const key of LEVER_ORDER) {
      const spec = LEVER_SPECS[key];
      rows.push(pad(spec.displayName, 16) + padStartNum(Math.round(cost.byLever[key]).toLocaleString(), 11));
    }
    rows.push(
      "-".repeat(27),
      pad("total", 16) + padStartNum(Math.round(cost.total).toLocaleString(), 11),
      pad("ceiling", 16) + padStartNum(ANNUAL_SECURITY_BUDGET_MXN_M.toLocaleString(), 11),
      "",
      cost.overBudget ? "OVER BUDGET" : "within budget",
      "",
      pad("cartels alive", 16) + padStartNum(String(this.you.survivingCartels), 11),
    );
    this.readoutEl.textContent = rows.join("\n");
    this.readoutEl.classList.toggle("over-budget", cost.overBudget);
  }
}

new Dashboard();
