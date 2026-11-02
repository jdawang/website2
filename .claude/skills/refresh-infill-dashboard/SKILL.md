---
name: refresh-infill-dashboard
model: claude-sonnet-5-5
description: Refresh the Edmonton neighbourhood infill dashboard (projects/infill-dashboard) with permit data up to a chosen "as of" date, which is usually today and does not have to be a quarter end. Use this whenever the user asks to update, refresh, rebuild or re-run the infill dashboard or infill map data, bump its AS_OF date, pull in newer building permits, or run build_data.R, even if they never say "skill" or name the dashboard exactly.
---

# Refresh the infill dashboard

The dashboard at `projects/infill-dashboard/` is static: `index.qmd` has no R, and the front end reads JSON that `_build/build_data.R` writes. A refresh means choosing an as-of date, rebuilding that JSON, and fixing the handful of places that hard-code the old date. CI cannot run R, so the regenerated files get committed.

The as-of date is the day the data is current to. Default to today's date unless the user gives another. It need not be a quarter end. Nothing in the pipeline depends on quarters; the old docs only said "quarterly" because that was the habit.

## 1. Preflight

Check these before changing anything, because the build is slow and fails late on missing inputs.

- `SOCRATA_KEY_ID` and `SOCRATA_KEY_SECRET` are available to R. They normally come from the `.Renviron` that R loads at startup, not from the shell, so `echo $SOCRATA_KEY_ID` coming back empty does not mean they are missing. Check from `_build/` the way the build will see them, printing only whether they are set and never their values:
  ```bash
  cd projects/infill-dashboard/_build
  Rscript -e 'cat(nzchar(Sys.getenv("SOCRATA_KEY_ID")), nzchar(Sys.getenv("SOCRATA_KEY_SECRET")), "\n")'   # expect TRUE TRUE
  ```
  Both the permit fetch (`get_edmonton_building_permit_data()`) and the property roll fetch stop without them.
- `EDMONTON_BP_CACHE_PATH` points at a directory (the usual one is `~/edmonton-bp-cache`). The run command in step 4 sets it inline, so the shell doesn't need it exported.
- The gitignored `data/` directory exists at the repo root. It holds the GTFS zip, neighbourhood boundaries, `osm_future_lrt.json` and `future_lrt_stops.geojson`.
- The working tree is clean for `projects/infill-dashboard/`, so the diff afterwards is only the refresh.

If R reports a credential as unset, tell the user which one and stop. Do not open `.Renviron` or print its contents, and do not hunt for keys elsewhere.

## 2. Pick the as-of date

Set `AS_OF` at the top of `_build/build_data.R` to the chosen date. The permit cache file is named by end date (`edmonton_building_permits_all_<AS_OF>.rds`), so a new date triggers a fresh download of all permits issued up to that date. That is what you want. It takes a few minutes and pages through the Socrata API. Reusing a cache for the same date is fine; use `force_refresh = TRUE` only if the user says the City corrected old records.

The month count is derived from `AS_OF` in the script (`N_MONTHS`), but the trailing comment on that line (`# 33`) is a literal. Update it so the next reader isn't misled.

A mid-month date means the final month is partial. The front end already labels a partial last year as "2026 (Jan–Oct)", but the last month's bar will look low. Say so in the summary if the date is not a month end.

## 3. Refresh the property roll if it is stale

Pass B of the geocoding matches permits that lack coordinates to the City's Property Information roll (Socrata `dkk9-cj3x`, RS rows). An old roll makes newly built lots geocode worse, and the map silently drops what it can't place.

`build_data.R` fetches it itself through the SODA3 API (`https://data.edmonton.ca/api/v3/views/dkk9-cj3x/query.json`, with the same `SOCRATA_KEY_ID`/`SOCRATA_KEY_SECRET` as the permits) and caches it as `edmonton_property_information_rs_<fetch date>.rds` in `EDMONTON_BP_CACHE_PATH`. It reuses the newest cache, so a refresh needs `PROPERTY_REFRESH=1` on the run. Do that when the newest cached roll is more than a few months older than the as-of date. The fetch date flows into `property_snapshot` in `permits.json`, which the page's methodology text prints, so there is nothing to edit by hand.

## 4. Run the build

```bash
cd projects/infill-dashboard/_build
EDMONTON_BP_CACHE_PATH=~/edmonton-bp-cache Rscript build_data.R   # prefix PROPERTY_REFRESH=1 to refetch the property roll
```

The script asserts on neighbourhood name matches, totals and coordinates, and fails rather than writing bad data. Read failures literally:

- **Unmatched neighbourhood names**: the City renamed or split one. Add a row to `_build/crosswalk.csv` (`from`, `to`) and rerun. Don't loosen the assertion.
- **A line-end future LRT stop is more than 200 m from a mapped alignment**: the OSM data is stale or incomplete. Rerun with `REFRESH_OSM=1`. The public Overpass server is often "too busy"; the script retries and then falls back to `data/osm_future_lrt.json`. If a line has opened since the last refresh, move its stops out of `data/future_lrt_stops.geojson` and refresh the GTFS zip.
- **Missing R package**: it is almost certainly not installed in this renv. `renv::restore()` in `_build/`, and install `jdawangHelpers` from GitHub (`renv::install_github("jdawang/jdawangHelpers")`), never from a local path.

Never edit the generated JSON by hand to get past an assertion.

## 5. Update the hard-coded dates

These are not generated, so they go stale silently.

- `index.qmd`: `date-modified` to today. Leave `date` alone; it is the original publish date.
- `index.qmd`: the slider's `max="32" value="32"` is `N_MONTHS - 1`. The JS resets it on load (`infill-map.js`, the slider-range function), so a wrong value won't break the page, but keep the HTML right for the first paint.
- `index.qmd`: year chips (`data-year="2024"` and so on). If `AS_OF` crosses into a new calendar year, add a chip for it. The JS also derives year labels from `2024 + floor(m / 12)`, which needs no change.
- Anything else that mentions the old month. Run `grep -rn "<old month name>\|<old date>" projects/infill-dashboard --include=*.qmd --include=*.js --include=*.css` and judge each hit, ignoring the big JSON files.

## 6. Verify

- `git check-ignore -v projects/infill-dashboard/*` must print nothing. If it prints a hit, an output landed somewhere `.gitignore` swallows it and the deployed map would be blank.
- Compare the `permits.json` meta block with the previous commit's (`git show HEAD:projects/infill-dashboard/permits.json | head -c 600` is enough since meta comes first): `as_of` moved, `n_total` and `units_total` did not drop, and `n_mapped` is close to `n_total`. A large fall in the mapped share means the property extract is stale or geocoding broke. A permit count that dropped needs an explanation before you continue.
- Render from the repo root with `quarto render projects/infill-dashboard/index.qmd`, or preview with `quarto preview`, and look at the page: the map loads, the slider ends on the new month, the table view (`#view=table`) has rows, and the "data as of" line in the methodology shows the new date. Use the `run` skill or a browser tool if one is available. If you cannot view it, say that instead of claiming it works.
- If the map's look changed substantially (new layers, different shading), the card thumbnail `thumbnail.jpg` (1200x630) is out of date. Mention that to the user rather than retaking it unprompted.

## 7. Report

Summarise in a few lines: the as-of date, permits and units before and after, the mapped share, any crosswalk rows added, and anything the user needs to do (stale property extract, thumbnail). Commit only if the user asks. If they do, stage the regenerated data files in `projects/infill-dashboard/`, `index.qmd`, `build_data.R`, and `crosswalk.csv` if it changed. Don't stage `data/`, which is gitignored.
