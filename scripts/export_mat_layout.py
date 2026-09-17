"""Export the cp_mat floor-plan layout to data/mat_layout.csv.

The layout (position, size, render flags) is Dataverse *data*, not a solution
component, so `pac solution export` never captures it. This script snapshots it
into a deterministic, diff-friendly CSV that can be committed alongside the
solution.

Deliberately excludes occupancy/client fields (cp_client, cp_sheltercheckin,
cp_clientlabel). Those hold real client names -- operational data with personal
information, which must not go into version control.

Usage:  python scripts/export_mat_layout.py
"""

import csv
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from auth import get_client  # noqa: E402

COLUMNS = [
    "cp_matnumber",
    "cp_matlabel",
    "cp_xposition",
    "cp_yposition",
    "cp_matwidth",
    "cp_matheight",
    "cp_defaultxposition",
    "cp_defaultyposition",
    "cp_render",
    "cp_standardmat",
    "cp_matgender",
    "cp_fillcolor",
    "cp_strokecolor",
    "cp_matid",
]

OUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "mat_layout.csv",
)


def fmt(value):
    """Render whole floats as ints (200.0 -> "200") so diffs stay readable."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def sort_key(row):
    """Numbered mats first in numeric order, then unnumbered by label."""
    number = row.get("cp_matnumber")
    if number is None:
        return (1, (row.get("cp_matlabel") or "").lower(), 0)
    return (0, "", float(number))


def main():
    client = get_client("dv-query")
    rows = list(client.records.list("cp_mat", select=COLUMNS))
    rows.sort(key=sort_key)

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(COLUMNS)
        for row in rows:
            writer.writerow([fmt(row.get(col)) for col in COLUMNS])

    print(f"Wrote {len(rows)} mats to {OUT_PATH}")


if __name__ == "__main__":
    main()
