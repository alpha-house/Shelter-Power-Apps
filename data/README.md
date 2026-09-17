# Version-controlled Dataverse data

Solution export (`solutions/Shelter`) captures *components* — tables, columns,
forms, views, flows, web resources. It does not capture **rows**. The mat
floor-plan lives in `cp_mat` rows, so without this folder the layout has no
history: a bad drag in the MatsOverlay PCF is silently unrecoverable from git.

## `mat_layout.csv`

A snapshot of the `cp_mat` floor plan — one row per mat, sorted numbered-first
by mat number, then unnumbered by label, so diffs stay readable and stable.

Regenerate after changing the layout:

```
python scripts/export_mat_layout.py
```

Then commit the result alongside the solution, so a layout change and the
solution state it belongs to land in the same commit.

### What is deliberately not in here

Occupancy columns (`cp_client`, `cp_sheltercheckin`, `cp_clientlabel`) are
excluded. `cp_clientlabel` holds real client names — that is personal
information and operational state, not configuration, and it must not enter
version control. Only layout and rendering configuration is snapshotted.

### Restoring a layout

There is no import script, and usually none is needed: `cp_defaultxposition` /
`cp_defaultyposition` already hold each mat's home position in Dataverse, so a
reset is a Dataverse-side operation. This CSV is for history, review, and
diffing what moved between commits.
