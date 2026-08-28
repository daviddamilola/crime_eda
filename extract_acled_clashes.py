"""Extract a compact, dated cartel-vs-cartel clash event list from the raw
ACLED LATAM export, using the same name-normalization/filtering pipeline as
cartel_network_timeline.ipynb (sections 1-2).

The raw file (`LATAM 20241209.csv`, ~273MB, all of Latin America) isn't
something the web dashboard's build should ever touch directly. This script
is the one-time (re-run when the ACLED export is refreshed) extraction step;
its output, `cartel_network/ACLED_Cartel_Clashes_2018_2024.csv`, is what
`web-dashboard/scripts/generate-cartel-data.mjs` reads at build time.

Run: .venv/bin/python3 extract_acled_clashes.py
"""

import re
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).parent
SOURCE_CSV = REPO_ROOT / "LATAM 20241209.csv"
OUTPUT_CSV = REPO_ROOT / "cartel_network" / "ACLED_Cartel_Clashes_2018_2024.csv"

# --- name normalization: identical to cartel_network_timeline.ipynb cell 5 ---
EXCLUDE_PATTERNS = [
    r"^Unidentified", r"^Police Forces", r"^Military Forces", r"^Self-Defense",
    r"Communal Militia", r"^Civilians", r"National Guard", r"^Protesters",
    r"^Rioters", r"Health Workers", r"Government of Mexico", r"^Journalists",
    r"Policia Comunitaria", r"^Rebel Group", r"Prison Guards",
    r"^(PRI|PRD|PAN|MORENA|MC|PT|PVEM|PES|RSP|FXM):",
    r"Institutional Revolutionary Party", r"Party of the Democratic Revolution",
    r"National Regeneration Movement", r"Strength and Heart for Mexico",
    r"National Action Party", r"Broad Front for Mexico", r"Citizens Movement",
    r"Labor Party \(Mexico\)", r"Ecologist Green Party",
]
EXCLUDE_RE = re.compile("|".join(EXCLUDE_PATTERNS))

CANON = {
    "Jalisco New Generation": "CJNG", "Sinaloa": "Sinaloa Cartel",
    "CDN": "Cartel del Noreste", "Golfo": "Gulf Cartel (Golfo)", "Gulf": "Gulf Cartel (Golfo)",
    "Los Chapitos": "Los Chapitos (Sinaloa)", "CU": "Carteles Unidos", "United Cartels": "Carteles Unidos",
    "Los Caballeros Templarios": "Caballeros Templarios",
}


def clean_name(name):
    if pd.isna(name):
        return None
    n = name.strip()
    n = re.sub(r"^[A-Z0-9]{2,6}:\s*", "", n)
    n = re.sub(r"\s*\(\d{4}-?\d*\)\s*", " ", n)
    n = re.sub(r"\s*\(Mexico\)\s*", " ", n)
    n = re.sub(r"\s+(Cartel|Gang|Group)$", "", n).strip()
    return n


def canon_name(raw):
    if pd.isna(raw) or EXCLUDE_RE.search(raw):
        return None
    c = clean_name(raw)
    return CANON.get(c, c)


NOTES_MAX_CHARS = 400  # ACLED's notes are a sentence or two; cap so the build output stays lean


def truncate_notes(text: str) -> str:
    text = " ".join(str(text).split())  # collapse embedded newlines/whitespace
    return text if len(text) <= NOTES_MAX_CHARS else text[: NOTES_MAX_CHARS - 1].rstrip() + "…"


def main() -> None:
    cols = [
        "country", "event_date", "year", "event_type", "sub_event_type", "actor1", "actor2",
        "inter1", "inter2", "admin1", "location", "latitude", "longitude", "fatalities", "notes",
    ]
    chunks = pd.read_csv(SOURCE_CSV, usecols=cols, chunksize=200_000)
    mex = pd.concat([c[c["country"] == "Mexico"] for c in chunks], ignore_index=True)
    mex["event_date"] = pd.to_datetime(mex["event_date"])
    print(f"Mexico events, {mex['year'].min()}-{mex['year'].max()}: {len(mex):,}")

    for col in ["actor1", "actor2"]:
        mex[col + "_canon"] = mex[col].apply(canon_name)
        inter_col = "inter1" if col == "actor1" else "inter2"
        mex.loc[mex[inter_col] != "Political militia", col + "_canon"] = None

    battles = mex[mex["event_type"] == "Battles"].copy()
    both_named = battles["actor1_canon"].notna() & battles["actor2_canon"].notna()
    clash = battles[both_named & (battles["actor1_canon"] != battles["actor2_canon"])].copy()
    clash["pair"] = clash.apply(lambda r: tuple(sorted([r["actor1_canon"], r["actor2_canon"]])), axis=1)
    clash[["cartel_a", "cartel_b"]] = pd.DataFrame(clash["pair"].tolist(), index=clash.index)

    # keep the same >=3-total-clashes floor the notebook uses, so this file's
    # cartel roster matches what the notebook validated against BACRIM
    deg = pd.concat([
        clash.groupby("cartel_a").size(),
        clash.groupby("cartel_b").size(),
    ]).groupby(level=0).sum()
    keep = set(deg[deg >= 3].index)
    clash = clash[clash["cartel_a"].isin(keep) & clash["cartel_b"].isin(keep)]

    out = clash[[
        "event_date", "year", "cartel_a", "cartel_b", "fatalities",
        "admin1", "location", "latitude", "longitude", "notes",
    ]].sort_values("event_date")
    out["event_date"] = out["event_date"].dt.strftime("%Y-%m-%d")
    out["notes"] = out["notes"].apply(truncate_notes)

    OUTPUT_CSV.parent.mkdir(exist_ok=True)
    out.to_csv(OUTPUT_CSV, index=False)
    print(f"Cartels in clash network (>=3 clashes, 2018-2024): {len(keep)}")
    print(f"Dated clash events written: {len(out):,} -> {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
