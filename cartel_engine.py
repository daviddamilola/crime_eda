"""
Cartel engine - the paper's equation, driven by whatever clock your game has.

Prieto-Curiel, Campedelli & Hope, Science 381:1312-1316 (2023):

    dC_i/dt = r*C_i  -  h*C_i/C  -  q*sum_{j!=i} C_i C_j S_ij  -  w*C_i^2
              recruit   incapacit.        conflict               saturation

Their one-letter symbols are kept only in this comment; the code spells
everything out. Symbol map:

    C_i -> members_per_cartel[i]        r -> recruitment_rate
    C   -> total_members                h -> incapacitation_capacity
    S   -> rivalry_matrix               q -> conflict_lethality
                                        w -> saturation_rate

There is no fixed window and nothing is keyed off a "level". You call
advance_by_weeks() once per tick with however much game-time has passed.
"""
from dataclasses import dataclass, field
from typing import NamedTuple
import numpy as np

# --- units --------------------------------------------------------------
WEEKS_PER_YEAR     = 52.0
SECONDS_PER_MINUTE = 60.0
NEGLIGIBLE_WEEKS   = 1e-9        # loop guard: below this, a tick is finished

# --- 2022 calibration anchors -------------------------------------------
MEMBERS_AT_START                  = 175_000   # cartel members in week zero
RECRUITS_PER_WEEK_AT_START        = 371.0     # 19,300 per year
INCAPACITATIONS_PER_WEEK_AT_START = 110.0     # 5,700 per year
CONFLICT_DEATHS_PER_WEEK_AT_START = 125.0     # 6,500 per year
DROPOUTS_PER_WEEK_AT_START        = 2.0       # residual of the flow accounting

# --- how the synthetic cartel landscape is generated --------------------
DEFAULT_CARTEL_COUNT           = 150    # active cartels the paper identifies
MAJOR_CARTEL_COUNT             = 10     # the top 10, holding >50% of members
CARTEL_SIZE_POWER_LAW_EXPONENT = -1.05  # heavy tail: size ~ rank ** exponent
MAJOR_VS_LOCAL_RIVALRY_CHANCE  = 0.45   # a big cartel fights a given local one
LOCAL_VS_LOCAL_RIVALRY_CHANCE  = 0.35   # a local cartel fights a nearby local one
LOCAL_RIVALRY_NEIGHBOURHOOD    = 4      # how many ranks away "nearby" reaches
DEFAULT_WORLD_SEED             = 7

# --- simulation behaviour -----------------------------------------------
DISBAND_THRESHOLD_MEMBERS  = 40.0   # a cartel smaller than this dissolves
MAX_INTEGRATION_STEP_WEEKS = 1.0    # RK4 substep ceiling - keeps long ticks stable

# --- default session shape ----------------------------------------------
DEFAULT_ROUND_MINUTES   = 5.0    # a round lasts this long in real time
DEFAULT_SIMULATED_YEARS = 2.0    # ...and represents this much history

# --- money --------------------------------------------------------------
ANNUAL_SECURITY_BUDGET_MXN_M = 190_491   # Mexico 2024 federal security function
MAX_SATURATION_BOOST         = 0.20      # full fragmentation raises saturation 20%


class LeverSpec(NamedTuple):
    """One policy slider: its range, its resting value, and what it costs."""
    minimum: float
    maximum: float
    default: float
    annual_cost_at_maximum: float   # MX$ millions per year
    display_name: str               # what the player sees on the slider
    affects: str                    # which model rate it scales


LEVER_SPECS = {
    "recruitment_prevention": LeverSpec(0.0, 1.00, 0.0,  35_000,
                                        "close the tap",   "recruitment_rate (down)"),
    "enforcement_effort":     LeverSpec(0.5, 1.85, 1.0, 102_664,
                                        "run the pumps",   "incapacitation_capacity (up)"),
    "conflict_suppression":   LeverSpec(0.0, 0.20, 0.0, 100_000,
                                        "seal the cracks", "conflict_lethality (down)"),
    "fragmentation_pressure": LeverSpec(0.0, 1.00, 0.0,  15_000,
                                        "open the drain",  "saturation_rate (up)"),
}


class GameClock:
    """Translate your game's tick into weeks of simulated time."""

    def __init__(self, weeks_per_tick=1.0):
        self.weeks_per_tick = weeks_per_tick

    @classmethod
    def timed_round(cls, seconds_per_tick,
                    round_minutes=DEFAULT_ROUND_MINUTES,
                    simulated_years=DEFAULT_SIMULATED_YEARS):
        """A round_minutes-long session that plays out simulated_years of history."""
        round_seconds    = round_minutes * SECONDS_PER_MINUTE
        weeks_per_second = (simulated_years * WEEKS_PER_YEAR) / round_seconds
        return cls(weeks_per_second * seconds_per_tick)

    @classmethod
    def realtime(cls, weeks_per_second, seconds_per_tick):
        return cls(weeks_per_second * seconds_per_tick)

    @classmethod
    def turn_based(cls, weeks_per_turn=WEEKS_PER_YEAR):
        return cls(weeks_per_turn)


@dataclass
class CartelWorld:
    members_per_cartel: np.ndarray        # C_i - one entry per cartel
    rivalry_matrix: np.ndarray            # S_ij - 1 where cartels i and j fight
    recruitment_rate: float               # r - new members per member per week
    incapacitation_capacity: float        # h - arrests per week, split pro-rata
    conflict_lethality: float             # q - deaths per rival-pair-member^2
    saturation_rate: float                # w - dropouts per member^2
    weeks_elapsed: float = 0.0
    money_spent_mxn_m: float = 0.0
    lever_values: dict = field(
        default_factory=lambda: {name: spec.default for name, spec in LEVER_SPECS.items()})

    # ------------------------------------------------------------- setup
    @classmethod
    def new(cls, cartel_count=DEFAULT_CARTEL_COUNT, seed=DEFAULT_WORLD_SEED):
        """Heavy-tailed cartel sizes plus a rivalry network, calibrated to 2022."""
        random_source = np.random.default_rng(seed)

        rank                = np.arange(1, cartel_count + 1)
        relative_size       = rank ** CARTEL_SIZE_POWER_LAW_EXPONENT
        members_per_cartel  = relative_size / relative_size.sum() * MEMBERS_AT_START

        rivalry_matrix = np.zeros((cartel_count, cartel_count))

        def make_rivals(one, other):
            rivalry_matrix[one, other] = rivalry_matrix[other, one] = 1.0

        for major in range(MAJOR_CARTEL_COUNT):
            for local in range(MAJOR_CARTEL_COUNT, cartel_count):
                if random_source.random() < MAJOR_VS_LOCAL_RIVALRY_CHANCE:
                    make_rivals(major, local)
            for other_major in range(major + 1, MAJOR_CARTEL_COUNT):
                make_rivals(major, other_major)

        for local in range(MAJOR_CARTEL_COUNT, cartel_count):
            neighbourhood_end = min(local + 1 + LOCAL_RIVALRY_NEIGHBOURHOOD, cartel_count)
            for neighbour in range(local + 1, neighbourhood_end):
                if random_source.random() < LOCAL_VS_LOCAL_RIVALRY_CHANCE:
                    make_rivals(local, neighbour)

        total_members  = members_per_cartel.sum()
        rival_exposure = members_per_cartel @ rivalry_matrix @ members_per_cartel
        return cls(
            members_per_cartel      = members_per_cartel,
            rivalry_matrix          = rivalry_matrix,
            recruitment_rate        = RECRUITS_PER_WEEK_AT_START / total_members,
            incapacitation_capacity = INCAPACITATIONS_PER_WEEK_AT_START,
            conflict_lethality      = CONFLICT_DEATHS_PER_WEEK_AT_START / rival_exposure,
            saturation_rate         = DROPOUTS_PER_WEEK_AT_START / (members_per_cartel ** 2).sum(),
        )

    def set_levers(self, **new_values):
        """Clamp and apply lever settings. Safe to call mid-round."""
        for name, spec in LEVER_SPECS.items():
            if name in new_values:
                self.lever_values[name] = min(max(float(new_values[name]), spec.minimum),
                                              spec.maximum)
        return self.lever_values

    # ------------------------------------------------------------- money
    def annual_cost(self):
        cost_by_lever = {name: spec.annual_cost_at_maximum * self.lever_values[name]
                         for name, spec in LEVER_SPECS.items()}
        total = sum(cost_by_lever.values())
        return {"by_lever": cost_by_lever,
                "total": total,
                "over_budget": total > ANNUAL_SECURITY_BUDGET_MXN_M + 0.5,
                "over_budget_by": max(0.0, total - ANNUAL_SECURITY_BUDGET_MXN_M)}

    # ------------------------------------------------------------- state
    @property
    def total_members(self):
        return float(self.members_per_cartel.sum())

    @property
    def surviving_cartels(self):
        return int((self.members_per_cartel > 0).sum())

    @property
    def deaths_per_week(self):
        _recruited, _incapacitated, killed_by_rivals, _dropped = \
            self._flow_terms(self.members_per_cartel)
        return float(killed_by_rivals.sum())

    @property
    def years_elapsed(self):
        return self.weeks_elapsed / WEEKS_PER_YEAR

    def is_winning(self):
        return (self.total_members   <= MEMBERS_AT_START and
                self.deaths_per_week <= CONFLICT_DEATHS_PER_WEEK_AT_START)

    # ------------------------------------------------------------- model
    def _effective_rates(self):
        """The four model rates after the player's levers are applied."""
        levers = self.lever_values
        recruitment_rate = self.recruitment_rate * (1 - levers["recruitment_prevention"])
        incapacitation_capacity = self.incapacitation_capacity * levers["enforcement_effort"]
        conflict_lethality = self.conflict_lethality * (1 - levers["conflict_suppression"])
        saturation_rate = self.saturation_rate * (
            1 + MAX_SATURATION_BOOST * levers["fragmentation_pressure"])
        return recruitment_rate, incapacitation_capacity, conflict_lethality, saturation_rate

    def _flow_terms(self, members_per_cartel):
        """The four terms of the equation, per cartel, in people per week."""
        (recruitment_rate, incapacitation_capacity,
         conflict_lethality, saturation_rate) = self._effective_rates()

        total_members = members_per_cartel.sum()
        if total_members <= 0:
            nothing = np.zeros_like(members_per_cartel)
            return nothing, nothing, nothing, nothing

        recruited        = recruitment_rate * members_per_cartel
        incapacitated    = incapacitation_capacity * members_per_cartel / total_members
        rival_contact    = self.rivalry_matrix @ members_per_cartel
        killed_by_rivals = conflict_lethality * members_per_cartel * rival_contact
        dropped_out      = saturation_rate * members_per_cartel ** 2
        return recruited, incapacitated, killed_by_rivals, dropped_out

    def _rate_of_change(self, members_per_cartel):
        recruited, incapacitated, killed_by_rivals, dropped_out = \
            self._flow_terms(members_per_cartel)
        return recruited - incapacitated - killed_by_rivals - dropped_out

    # ------------------------------------------------------------- tick
    def advance_by_weeks(self, weeks_this_tick):
        """Integrate forward. Substeps internally, so the caller may pass one
        frame, one week or one year. Returns the flows during THIS tick."""
        flows_this_tick = {"recruited": 0.0, "incapacitated": 0.0,
                           "killed_by_rivals": 0.0, "dropped_out": 0.0}
        weeks_remaining = float(weeks_this_tick)

        while weeks_remaining > NEGLIGIBLE_WEEKS:
            step_weeks = min(MAX_INTEGRATION_STEP_WEEKS, weeks_remaining)
            weeks_remaining -= step_weeks
            members = self.members_per_cartel

            # classic Runge-Kutta 4, clamped so no cartel can go negative
            slope_at_start  = self._rate_of_change(members)
            slope_at_mid_a  = self._rate_of_change(
                np.maximum(members + step_weeks / 2 * slope_at_start, 0))
            slope_at_mid_b  = self._rate_of_change(
                np.maximum(members + step_weeks / 2 * slope_at_mid_a, 0))
            slope_at_end    = self._rate_of_change(
                np.maximum(members + step_weeks * slope_at_mid_b, 0))
            average_slope = (slope_at_start + 2 * slope_at_mid_a
                             + 2 * slope_at_mid_b + slope_at_end) / 6

            members = np.maximum(members + step_weeks * average_slope, 0.0)
            members[members < DISBAND_THRESHOLD_MEMBERS] = 0.0   # that cartel dissolves
            self.members_per_cartel = members

            recruited, incapacitated, killed_by_rivals, dropped_out = self._flow_terms(members)
            flows_this_tick["recruited"]        += recruited.sum()        * step_weeks
            flows_this_tick["incapacitated"]    += incapacitated.sum()    * step_weeks
            flows_this_tick["killed_by_rivals"] += killed_by_rivals.sum() * step_weeks
            flows_this_tick["dropped_out"]      += dropped_out.sum()      * step_weeks
            self.weeks_elapsed += step_weeks

        years_this_tick = float(weeks_this_tick) / WEEKS_PER_YEAR
        self.money_spent_mxn_m += self.annual_cost()["total"] * years_this_tick
        flows_this_tick["net_change"] = (flows_this_tick["recruited"]
                                         - flows_this_tick["incapacitated"]
                                         - flows_this_tick["killed_by_rivals"]
                                         - flows_this_tick["dropped_out"])
        return flows_this_tick

    def run_for_weeks(self, weeks, weeks_per_tick=MAX_INTEGRATION_STEP_WEEKS):
        """Convenience wrapper: many ticks at once."""
        history, weeks_left = [], weeks
        while weeks_left > NEGLIGIBLE_WEEKS:
            step_weeks = min(weeks_per_tick, weeks_left)
            weeks_left -= step_weeks
            history.append((self.weeks_elapsed + step_weeks,
                            self.advance_by_weeks(step_weeks)))
        return history
