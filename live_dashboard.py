"""
Flood House - live control room.

A 5-minute round. Drag the sliders WHILE the clock runs and watch the two
charts diverge from the do-nothing counterfactual that runs alongside you.

    python3 live_dashboard.py
"""
import matplotlib
import matplotlib.pyplot as plt
from matplotlib.widgets import Slider, Button
from matplotlib.animation import FuncAnimation
from cartel_engine import (CartelWorld, LEVER_SPECS, MEMBERS_AT_START,
                           CONFLICT_DEATHS_PER_WEEK_AT_START,
                           ANNUAL_SECURITY_BUDGET_MXN_M)

# ------------------------------------------------------------------ session
ROUND_MINUTES        = 10.0     # real time one round lasts
SIMULATED_YEARS      = 2.0     # history that round represents
FRAMES_PER_SECOND    = 20      # animation refresh rate
ROUND_SECONDS        = ROUND_MINUTES * 60.0
WEEKS_PER_SECOND     = (SIMULATED_YEARS * 52.0) / ROUND_SECONDS

# ------------------------------------------------------------------ palette
PAGE_BACKGROUND   = "#06101a"
CHART_SURFACE     = "#0d1b25"
GRIDLINE          = "#1e3a49"
SLIDER_TRACK      = "#132632"
TEXT_PRIMARY      = "#e6f0f4"
TEXT_SECONDARY    = "#8ba3af"
SERIES_YOUR_RUN   = "#3987e5"   # validated categorical pair
SERIES_DO_NOTHING = "#d95926"
REFERENCE_LINE    = "#c4552e"   # the 2022 win line

plt.rcParams.update({
    "figure.facecolor": PAGE_BACKGROUND, "axes.facecolor": CHART_SURFACE, "savefig.facecolor": PAGE_BACKGROUND,
    "text.color": TEXT_PRIMARY, "axes.labelcolor": TEXT_SECONDARY, "xtick.color": TEXT_SECONDARY,
    "ytick.color": TEXT_SECONDARY, "axes.edgecolor": GRIDLINE, "grid.color": GRIDLINE,
    "font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold",
})


class Dashboard:
    def __init__(self):
        self.reset_worlds()
        self.running, self.elapsed = True, 0.0
        self.marks = []                       # (week, lever) for each tweak
        self.build()

    def reset_worlds(self):
        self.you   = CartelWorld.new()              # the run you are steering
        self.ghost = CartelWorld.new()              # untouched counterfactual
        self.t, self.y_size, self.g_size = [0.], [MEMBERS_AT_START], [MEMBERS_AT_START]
        self.y_dead, self.g_dead = [CONFLICT_DEATHS_PER_WEEK_AT_START], [CONFLICT_DEATHS_PER_WEEK_AT_START]

    # -------------------------------------------------------------- layout
    def build(self):
        self.fig = plt.figure(figsize=(12, 7.6))
        self.fig.canvas.manager.set_window_title("Flood House - control room")
        gs = self.fig.add_gridspec(2, 2, width_ratios=[3, 1.35],
                                   height_ratios=[1, 1],
                                   left=.07, right=.975, top=.88, bottom=.09,
                                   hspace=.34, wspace=.22)
        self.ax_size = self.fig.add_subplot(gs[0, 0])
        self.ax_dead = self.fig.add_subplot(gs[1, 0], sharex=self.ax_size)
        self.panel   = self.fig.add_subplot(gs[:, 1]); self.panel.axis("off")

        self.title = self.fig.suptitle("", x=.07, ha="left", fontsize=15,
                                       fontweight="bold", color=TEXT_PRIMARY)
        self.sub = self.fig.text(.07, .915, "", ha="left", fontsize=9.5, color=TEXT_SECONDARY)

        # --- chart 1: cartel members (never share an axis with deaths) ---
        a = self.ax_size
        a.set_title("Cartel members", loc="left", color=TEXT_PRIMARY, pad=8)
        a.axhline(MEMBERS_AT_START, color=REFERENCE_LINE, lw=1.2, ls=(0, (5, 4)), zorder=1)
        a.text(.985, MEMBERS_AT_START, "2022 line - get under it to win ", va="bottom",
               ha="right", fontsize=8, color=REFERENCE_LINE, transform=a.get_yaxis_transform())
        self.l_gsize, = a.plot([], [], lw=2, color=SERIES_DO_NOTHING, ls=(0, (4, 3)),
                               label="If you did nothing")
        self.l_ysize, = a.plot([], [], lw=2.4, color=SERIES_YOUR_RUN, label="Your run")
        self.d_ysize, = a.plot([], [], "o", ms=8, color=SERIES_YOUR_RUN, mec=CHART_SURFACE, mew=2, zorder=5)
        self.tag_size = a.annotate("", xy=(0, 0), xytext=(9, 0), fontsize=9,
                                   textcoords="offset points", va="center", color=TEXT_PRIMARY)
        a.legend(loc="upper left", frameon=False, fontsize=8.5, labelcolor=TEXT_SECONDARY)

        # --- chart 2: killings per week ---
        b = self.ax_dead
        b.set_title("Killings per week", loc="left", color=TEXT_PRIMARY, pad=8)
        b.axhline(CONFLICT_DEATHS_PER_WEEK_AT_START, color=REFERENCE_LINE, lw=1.2, ls=(0, (5, 4)), zorder=1)
        b.text(.985, CONFLICT_DEATHS_PER_WEEK_AT_START, "2022 line ", va="bottom", ha="right", fontsize=8,
               color=REFERENCE_LINE, transform=b.get_yaxis_transform())
        self.l_gdead, = b.plot([], [], lw=2, color=SERIES_DO_NOTHING, ls=(0, (4, 3)))
        self.l_ydead, = b.plot([], [], lw=2.4, color=SERIES_YOUR_RUN)
        self.d_ydead, = b.plot([], [], "o", ms=8, color=SERIES_YOUR_RUN, mec=CHART_SURFACE, mew=2, zorder=5)
        self.tag_dead = b.annotate("", xy=(0, 0), xytext=(9, 0), fontsize=9,
                                   textcoords="offset points", va="center", color=TEXT_PRIMARY)
        b.set_xlabel("weeks elapsed")

        for ax in (a, b):
            ax.grid(True, lw=.6, alpha=.5); ax.set_axisbelow(True)
            for s in ("top", "right"): ax.spines[s].set_visible(False)

        # --- live sliders ---
        self.sliders, specs = {}, [
            ("recruitment_prevention", "Close the tap",   SERIES_YOUR_RUN),
            ("enforcement_effort",     "Run the pumps",   TEXT_SECONDARY),
            ("conflict_suppression",   "Seal the cracks", TEXT_SECONDARY),
            ("fragmentation_pressure", "Open the drain",  TEXT_SECONDARY)]
        for i, (key, label, col) in enumerate(specs):
            spec = LEVER_SPECS[key]
            ax = self.fig.add_axes([.795, .70 - i * .105, .165, .022],
                                   facecolor=SLIDER_TRACK)
            s = Slider(ax, "", spec.minimum, spec.maximum, valinit=spec.default,
                       color=col, track_color=SLIDER_TRACK)
            s.valtext.set_color(TEXT_PRIMARY); s.valtext.set_fontsize(9)
            ax.set_title(label, loc="left", fontsize=9, color=col, pad=5)
            s.on_changed(lambda v, k=key: self.on_lever(k, v))
            self.sliders[key] = s

        self.readout = self.fig.text(.795, .335, "", fontsize=8.5, color=TEXT_SECONDARY,
                                     va="top", family="monospace")
        bax = self.fig.add_axes([.795, .045, .078, .042])
        self.btn_pause = Button(bax, "Pause", color=SLIDER_TRACK, hovercolor="#1e3a49")
        self.btn_pause.label.set_color(TEXT_PRIMARY); self.btn_pause.on_clicked(self.toggle)
        rax = self.fig.add_axes([.882, .045, .078, .042])
        self.btn_reset = Button(rax, "Reset", color=SLIDER_TRACK, hovercolor="#1e3a49")
        self.btn_reset.label.set_color(TEXT_PRIMARY); self.btn_reset.on_clicked(self.reset)

        self.anim = FuncAnimation(self.fig, self.update, interval=1000 // FRAMES_PER_SECOND,
                                  blit=False, cache_frame_data=False)

    # -------------------------------------------------------------- events
    def on_lever(self, key, value):
        """Sliders write straight into the live world - mid-round is fine."""
        self.you.set_levers(**{key: value})
        self.marks.append((self.you.weeks_elapsed, key))
        for ax in (self.ax_size, self.ax_dead):
            ax.axvline(self.you.weeks_elapsed, color=TEXT_SECONDARY, lw=1, alpha=.55, zorder=0,
                       ls=(0, (2, 3)), label="_tweak")

    def toggle(self, _):
        self.running = not self.running
        self.btn_pause.label.set_text("Resume" if not self.running else "Pause")

    def reset(self, _):
        self.reset_worlds(); self.elapsed = 0.; self.running = True
        self.btn_pause.label.set_text("Pause")
        for s in self.sliders.values(): s.reset()
        for ax in (self.ax_size, self.ax_dead):
            for ln in list(ax.lines):
                if ln.get_label() == "_tweak": ln.remove()

    # -------------------------------------------------------------- frame
    def update(self, _frame):
        if self.running and self.elapsed < ROUND_SECONDS:
            dt = min(1.0 / FRAMES_PER_SECOND, ROUND_SECONDS - self.elapsed)
            self.elapsed += dt
            self.you.advance_by_weeks(dt * WEEKS_PER_SECOND)
            self.ghost.advance_by_weeks(dt * WEEKS_PER_SECOND)
            self.t.append(self.you.weeks_elapsed)
            self.y_size.append(self.you.total_members);  self.g_size.append(self.ghost.total_members)
            self.y_dead.append(self.you.deaths_per_week)
            self.g_dead.append(self.ghost.deaths_per_week)
        self.redraw()

    def redraw(self):
        self.l_ysize.set_data(self.t, self.y_size); self.l_gsize.set_data(self.t, self.g_size)
        self.l_ydead.set_data(self.t, self.y_dead); self.l_gdead.set_data(self.t, self.g_dead)
        x, ys, yd = self.t[-1], self.y_size[-1], self.y_dead[-1]
        self.d_ysize.set_data([x], [ys]); self.d_ydead.set_data([x], [yd])
        self.tag_size.set_position((9, 0)); self.tag_size.xy = (x, ys)
        self.tag_size.set_text(f"{ys:,.0f}")
        self.tag_dead.xy = (x, yd); self.tag_dead.set_text(f"{yd:,.0f}")

        for ax, lo, hi in ((self.ax_size, min(self.y_size + self.g_size + [MEMBERS_AT_START]),
                                          max(self.y_size + self.g_size + [MEMBERS_AT_START])),
                           (self.ax_dead, min(self.y_dead + self.g_dead + [CONFLICT_DEATHS_PER_WEEK_AT_START]),
                                          max(self.y_dead + self.g_dead + [CONFLICT_DEATHS_PER_WEEK_AT_START]))):
            pad = (hi - lo) * .18 or 1
            ax.set_xlim(0, max(self.you.weeks_elapsed * 1.12, 4)); ax.set_ylim(lo - pad, hi + pad)

        rem = max(0., ROUND_SECONDS - self.elapsed)
        m, s = divmod(int(rem), 60)
        year, wk = 2022 + int(self.you.weeks_elapsed // 52), int(self.you.weeks_elapsed % 52) + 1
        over = self.elapsed >= ROUND_SECONDS
        won = self.you.is_winning()
        self.title.set_text(
            f"{m}:{s:02d}   ·   {year} week {wk}"
            + ("   ·   " + ("SERIES_YOUR_RUN CLOSED THE TAP" if won else "THE WATER WON") if over else ""))
        self.title.set_color(TEXT_PRIMARY if not over else (SERIES_YOUR_RUN if won else SERIES_DO_NOTHING))
        gap = self.you.total_members - self.ghost.total_members
        self.sub.set_text(
            f"{gap:+,.0f} members vs. doing nothing   ·   "
            f"{self.you.deaths_per_week - self.ghost.deaths_per_week:+.0f} killings/wk   ·   "
            f"MX${self.you.money_spent_mxn_m/1000:,.0f} bn spent")

        c = self.you.annual_cost()
        rows = [f"{'BUDGET':<16}{'MX$M/yr':>11}", "-" * 27]
        for key, spec in LEVER_SPECS.items():
            rows.append(f"{spec.display_name:<16}{c['by_lever'][key]:>11,.0f}")
        rows += ["-" * 27,
                 f"{'total':<16}{c['total']:>11,.0f}",
                 f"{'ceiling':<16}{ANNUAL_SECURITY_BUDGET_MXN_M:>11,.0f}",
                 "", f"{'OVER BUDGET' if c['over_budget'] else 'within budget'}",
                 "", f"{'cartels alive':<16}{self.you.surviving_cartels:>11}"]
        self.readout.set_text("\n".join(rows))
        self.readout.set_color(SERIES_DO_NOTHING if c["over_budget"] else TEXT_SECONDARY)


if __name__ == "__main__":
    Dashboard(); plt.show()
