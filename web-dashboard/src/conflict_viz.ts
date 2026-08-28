/**
 * Live clash map: real Mexico state boundaries (D3 + a bundled geojson),
 * cartels placed at the state they're active in (from CARTEL_STATES), real
 * rivalries drawn as faint arcs between them.
 *
 * Clashes are event-driven, not a static snapshot: each rivalry edge has a
 * casualty accumulator that fills at CartelWorld.clashIntensities()'s
 * current rate; whenever it crosses INCIDENT_CASUALTY_SIZE, one glowing
 * ring pulse fires at each end of that rivalry and the edge itself flashes -
 * so a hot rivalry pulses rapidly and a cold one flickers rarely, all sized
 * by that incident's intensity.
 *
 * D3 (global `d3`, loaded via <script> in index.html) owns the animation:
 * each pulse is a <circle> with a D3 transition that grows its radius and
 * fades it to zero, then removes itself - no manual pulse bookkeeping.
 */
import type { CartelWorld, ClashIntensity } from "./cartel_engine.js";
import { CARTEL_CLASH_EVENTS, type CartelClashEvent } from "./cartel_network_data.generated.js";

declare const d3: any;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const GEO_URL = "./assets/mexico_states.geo.json";

const MAP_BACKGROUND = "#0d1b25";
const STATE_FILL = "#132632";
const STATE_STROKE = "#1e3a49";
const NODE_FILL = "#3987e5";
const EDGE_BASE = "#1e3a49";
const EDGE_ACTIVE = "#ff5a3c";
const PULSE_COLOR = "#ff5a3c";
const TEXT_PRIMARY = "#e6f0f4";
const TEXT_SECONDARY = "#8ba3af";

const INCIDENT_CASUALTY_SIZE = 3; // deaths accumulated per visible pulse
const MAX_PULSES_PER_EDGE_PER_FRAME = 4; // guard against a huge dt (e.g. tab regains focus)
const PULSE_DURATION_MS = 950;
const PULSE_MIN_RADIUS = 3;
const PULSE_MAX_RADIUS = 24;
const PULSE_INTENSITY_SCALE = 60; // deaths/week that maps to a full-size pulse
const EDGE_FLASH_DURATION_MS = 650;
const JITTER_RADIUS_PX = 13; // spread for cartels sharing one state

interface ScreenPoint {
  x: number;
  y: number;
}

export class ConflictMap {
  private svg: any;
  private ready = false;
  private positions = new Map<number, ScreenPoint>();
  private edgeElements = new Map<string, any>();
  private nodeGroup: any;
  private pulseGroup: any;
  private labelBg: any;
  private labelText: any;
  private titleText: any;
  private accumulator = new Map<string, number>();
  private eventsByCartel = new Map<number, CartelClashEvent[]>();
  private tooltipEl: HTMLDivElement;
  private currentWorld: CartelWorld | null = null;

  constructor(private svgEl: SVGSVGElement) {
    this.svg = d3.select(svgEl);

    for (const event of CARTEL_CLASH_EVENTS) {
      if (!this.eventsByCartel.has(event.a)) this.eventsByCartel.set(event.a, []);
      if (!this.eventsByCartel.has(event.b)) this.eventsByCartel.set(event.b, []);
      this.eventsByCartel.get(event.a)!.push(event);
      this.eventsByCartel.get(event.b)!.push(event);
    }
    for (const events of this.eventsByCartel.values()) {
      events.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0)); // most recent first
    }

    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "clash-tooltip";
    document.body.appendChild(this.tooltipEl);
  }

  /** One-time setup: load the real geography, place cartels, draw statics. */
  async init(world: CartelWorld): Promise<void> {
    const geo = await d3.json(GEO_URL);
    const width = this.svgEl.clientWidth || 480;
    const height = this.svgEl.clientHeight || 420;
    this.svg.attr("viewBox", `0 0 ${width} ${height}`);
    this.svg.selectAll("*").remove();

    const projection = d3.geoMercator().fitSize([width, height], geo);
    const path = d3.geoPath(projection);

    const defs = this.svg.append("defs");
    const glow = defs
      .append("filter")
      .attr("id", "clash-glow")
      .attr("x", "-200%")
      .attr("y", "-200%")
      .attr("width", "500%")
      .attr("height", "500%");
    glow.append("feGaussianBlur").attr("stdDeviation", 3.2).attr("result", "blur");
    const merge = glow.append("feMerge");
    merge.append("feMergeNode").attr("in", "blur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    this.svg.append("rect").attr("width", width).attr("height", height).attr("fill", MAP_BACKGROUND);

    this.svg
      .append("g")
      .attr("class", "states")
      .selectAll("path")
      .data(geo.features)
      .join("path")
      .attr("d", path)
      .attr("fill", STATE_FILL)
      .attr("stroke", STATE_STROKE)
      .attr("stroke-width", 0.75);

    const centroids = new Map<string, [number, number]>();
    for (const feature of geo.features) {
      centroids.set(feature.properties.name, projection(d3.geoCentroid(feature)));
    }

    const active = new Set<number>();
    for (const edge of world.rivalryEdges) {
      active.add(edge.i);
      active.add(edge.j);
    }

    const byState = new Map<string, number[]>();
    for (const i of active) {
      const state = world.states[i] ?? "";
      if (!centroids.has(state)) continue; // defensive: skip if a state name doesn't match the geojson
      if (!byState.has(state)) byState.set(state, []);
      byState.get(state)!.push(i);
    }

    this.positions.clear();
    for (const [state, members] of byState) {
      const [cx, cy] = centroids.get(state)!;
      const k = members.length;
      members.forEach((cartelIndex, idx) => {
        if (k === 1) {
          this.positions.set(cartelIndex, { x: cx, y: cy });
        } else {
          const angle = (idx / k) * Math.PI * 2;
          this.positions.set(cartelIndex, {
            x: cx + Math.cos(angle) * JITTER_RADIUS_PX,
            y: cy + Math.sin(angle) * JITTER_RADIUS_PX,
          });
        }
      });
    }

    const edgesG = this.svg.append("g").attr("class", "edges");
    this.edgeElements.clear();
    this.accumulator.clear();
    for (const edge of world.rivalryEdges) {
      const p1 = this.positions.get(edge.i);
      const p2 = this.positions.get(edge.j);
      if (!p1 || !p2) continue;
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2 - 12;
      const element = edgesG
        .append("path")
        .attr("d", `M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}`)
        .attr("fill", "none")
        .attr("stroke", EDGE_BASE)
        .attr("stroke-width", 0.6 + Math.min(2, edge.weight * 0.25))
        .attr("stroke-opacity", 0.5);
      this.edgeElements.set(`${edge.i},${edge.j}`, element);
      this.accumulator.set(`${edge.i},${edge.j}`, 0);
    }

    this.pulseGroup = this.svg.append("g").attr("class", "pulses").attr("filter", "url(#clash-glow)");
    this.nodeGroup = this.svg.append("g").attr("class", "nodes");

    const labelGroup = this.svg.append("g").attr("class", "labels");
    this.labelBg = labelGroup
      .append("rect")
      .attr("x", 8)
      .attr("y", 8)
      .attr("rx", 4)
      .attr("fill", "rgba(6,16,26,0.75)")
      .attr("width", 0)
      .attr("height", 0);
    this.labelText = labelGroup
      .append("text")
      .attr("x", 14)
      .attr("y", 22)
      .attr("fill", TEXT_SECONDARY)
      .attr("font-family", "ui-monospace, SFMono-Regular, Menlo, monospace")
      .attr("font-size", 10);

    this.titleText = this.svg
      .append("text")
      .attr("x", 14)
      .attr("y", height - 10)
      .attr("fill", TEXT_PRIMARY)
      .attr("font-family", "-apple-system, sans-serif")
      .attr("font-weight", "bold")
      .attr("font-size", 12);

    this.currentWorld = world;
    this.ready = true;
    this.updateNodes(world);
  }

  private updateNodes(world: CartelWorld): void {
    const activeIndices = Array.from(this.positions.keys());
    const maxMembers = Math.max(1, ...activeIndices.map((i) => world.membersPerCartel[i] ?? 0));
    this.nodeGroup
      .selectAll("circle")
      .data(activeIndices, (d: number) => d)
      .join("circle")
      .attr("cx", (i: number) => this.positions.get(i)!.x)
      .attr("cy", (i: number) => this.positions.get(i)!.y)
      .attr("r", (i: number) => 1.5 + 7 * Math.sqrt((world.membersPerCartel[i] ?? 0) / maxMembers))
      .attr("fill", NODE_FILL)
      .attr("fill-opacity", 0.9)
      .style("cursor", "pointer")
      .on("pointerenter", (event: PointerEvent, i: number) => this.showTooltip(event, i))
      .on("pointermove", (event: PointerEvent) => this.positionTooltip(event))
      .on("pointerleave", () => this.hideTooltip());
  }

  private showTooltip(event: PointerEvent, i: number): void {
    const world = this.currentWorld;
    if (!world) return;

    const name = world.names[i] ?? `#${i}`;
    const state = world.states[i] ?? "";
    const members = Math.round(world.membersPerCartel[i] ?? 0).toLocaleString();
    const events = this.eventsByCartel.get(i) ?? [];

    let html = `<div class="clash-tooltip-title">${escapeHtml(name)}</div>`;
    html += `<div class="clash-tooltip-meta">${escapeHtml(state)} · ~${members} members (simulated)</div>`;

    if (events.length > 0) {
      const latest = events[0]!;
      const opponentIndex = latest.a === i ? latest.b : latest.a;
      const opponentName = world.names[opponentIndex] ?? `#${opponentIndex}`;
      html += `<div class="clash-tooltip-meta">${events.length} recorded clash${events.length === 1 ? "" : "es"}, 2018–2024 (ACLED)</div>`;
      html += `<div class="clash-tooltip-event">`;
      html += `<div class="clash-tooltip-event-head">${latest.date} · vs ${escapeHtml(opponentName)} · ${latest.fatalities} killed</div>`;
      html += `<div class="clash-tooltip-event-loc">${escapeHtml(latest.location)}, ${escapeHtml(latest.state)}</div>`;
      html += `<div class="clash-tooltip-event-notes">${escapeHtml(latest.notes)}</div>`;
      html += `</div>`;
    } else {
      html += `<div class="clash-tooltip-meta clash-tooltip-muted">No ACLED-linked clashes on record</div>`;
    }

    this.tooltipEl.innerHTML = html;
    this.tooltipEl.style.display = "block";
    this.positionTooltip(event);
  }

  private positionTooltip(event: PointerEvent): void {
    const offset = 14;
    const rect = this.tooltipEl.getBoundingClientRect();
    let left = event.clientX + offset;
    let top = event.clientY + offset;
    if (left + rect.width > window.innerWidth) left = event.clientX - rect.width - offset;
    if (top + rect.height > window.innerHeight) top = event.clientY - rect.height - offset;
    this.tooltipEl.style.left = `${left}px`;
    this.tooltipEl.style.top = `${top}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = "none";
  }

  /** Call once per animation frame. dtWeeks is how much sim-time just passed. */
  update(world: CartelWorld, dtWeeks: number, title: string): void {
    if (!this.ready) return;
    this.currentWorld = world;
    this.updateNodes(world);

    const clashes: ClashIntensity[] = world.clashIntensities();
    if (dtWeeks > 0) {
      for (const clash of clashes) {
        const key = `${clash.i},${clash.j}`;
        let remaining = (this.accumulator.get(key) ?? 0) + clash.deathsPerWeek * dtWeeks;
        let fired = 0;
        while (remaining >= INCIDENT_CASUALTY_SIZE && fired < MAX_PULSES_PER_EDGE_PER_FRAME) {
          this.firePulse(clash);
          remaining -= INCIDENT_CASUALTY_SIZE;
          fired++;
        }
        this.accumulator.set(key, remaining);
      }
    }

    const topClashes = [...clashes]
      .sort((a, b) => b.deathsPerWeek - a.deathsPerWeek)
      .slice(0, 3)
      .filter((c) => c.deathsPerWeek >= 0.05);
    this.renderLabels(world, topClashes, title);
  }

  private firePulse(clash: ClashIntensity): void {
    const p1 = this.positions.get(clash.i);
    const p2 = this.positions.get(clash.j);
    if (!p1 || !p2) return;

    const key = `${clash.i},${clash.j}`;
    const edge = this.edgeElements.get(key);
    if (edge) {
      edge
        .interrupt()
        .attr("stroke", EDGE_ACTIVE)
        .attr("stroke-opacity", 0.95)
        .transition()
        .duration(EDGE_FLASH_DURATION_MS)
        .attr("stroke", EDGE_BASE)
        .attr("stroke-opacity", 0.5);
    }

    const intensityT = Math.min(1, clash.deathsPerWeek / PULSE_INTENSITY_SCALE);
    const maxRadius = PULSE_MIN_RADIUS + (PULSE_MAX_RADIUS - PULSE_MIN_RADIUS) * intensityT;

    for (const p of [p1, p2]) {
      this.pulseGroup
        .append("circle")
        .attr("cx", p.x)
        .attr("cy", p.y)
        .attr("r", PULSE_MIN_RADIUS)
        .attr("fill", "none")
        .attr("stroke", PULSE_COLOR)
        .attr("stroke-width", 2)
        .style("opacity", 0.9)
        .transition()
        .duration(PULSE_DURATION_MS)
        .ease(d3.easeCubicOut)
        .attr("r", maxRadius)
        .style("opacity", 0)
        .remove();
    }
  }

  private renderLabels(world: CartelWorld, top: ClashIntensity[], title: string): void {
    this.titleText.text(title);
    if (top.length === 0) {
      this.labelText.selectAll("tspan").remove();
      this.labelBg.attr("width", 0).attr("height", 0);
      return;
    }
    const lines = top.map(
      (c) => `${world.names[c.i] ?? c.i} vs ${world.names[c.j] ?? c.j} · ${c.deathsPerWeek.toFixed(1)}/wk`,
    );
    this.labelText
      .selectAll("tspan")
      .data(lines)
      .join("tspan")
      .attr("x", 14)
      .attr("dy", (_: string, idx: number) => (idx === 0 ? 0 : 13))
      .text((d: string) => d);
    const widestLine = Math.max(...lines.map((l) => l.length));
    this.labelBg.attr("width", widestLine * 5.6 + 20).attr("height", lines.length * 13 + 12);
  }

  /** Clear in-flight pulses and accumulators - call on a game reset. */
  resetAnimationState(): void {
    for (const key of this.accumulator.keys()) this.accumulator.set(key, 0);
    if (this.pulseGroup) this.pulseGroup.selectAll("circle").interrupt().remove();
  }
}
