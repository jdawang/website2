# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jacob Dawang's personal website and blog at [jacobdawang.com](https://www.jacobdawang.com), built with [Quarto](https://quarto.org/). Blog posts are data analysis pieces focused on Edmonton housing, zoning, and transit, written in R using Quarto documents (`.qmd`).

## Build commands

```bash
# Preview site locally (live reload)
quarto preview

# Render the full site
quarto render
```

Always render a single post from within the post's directory. This allows for the post to be rendered within its own environment. For example:
```bash
# Render a single post (from post directory)
cd blog/2026/nodes-corridors
quarto render blog/2026/nodes-corridors/index.qmd
```

Deployment is automatic via GitHub Actions on push to `main`: renders with Quarto and deploys to Cloudflare Pages. Deployment to a preview url is automatic via GitHub actions on pushes to open pull requests.

## Architecture

- **`_quarto.yml`**: Site-level config (theme, navbar, footer, extensions). `freeze: true` means computed R outputs are cached in `_freeze/` and not re-executed unless the source changes.
- **`blog/_metadata.yml`**: Defaults for all blog posts (freeze, echo/message/warning suppression, giscus comments, title-block-banner).
- **`_freeze/`**: Cached execution results (JSON + figures). Committed to the repo so CI doesn't need R packages installed.
- **`_site/`**: Build output, committed to repo.
- **`_extensions/`**: Quarto extensions (fontawesome, iconify, social-embeds).
- **`custom_styles.scss` / `custom_styles_dark.scss`**: Theme overrides for light/dark modes on top of the cosmo Bootstrap theme.
- **`data/`**: Shared datasets (geojson, csv, zip) referenced across blog posts.

## Blog post structure

Each post lives at `blog/YYYY/post-slug/index.qmd`. The frontmatter pattern:

```yaml
---
title: "Post title"
date: "YYYY-MM-DD"
author: "Jacob Dawang"
categories: [category1, category2, category3]
description: "few sentence summary"
link-external-newwindow: true
link-external-icon: false
---
```

Posts use R code chunks with knitr. Common libraries: `tidyverse`, `sf`, `gt`, `ggplot2`, `cancensus`, `mountainmathHelpers`. Data paths typically reference `../../../data` relative to the post via `here()`.

In the first R chunk, along with imports, always load the following options like the following. These set important API keys and cache paths for the cancensus and jdawangHelpers packages:

```r
options(
  cancensus.api_key = Sys.getenv("CM_API_KEY"),
  cancensus.cache_path = Sys.getenv("CM_CACHE_PATH"),
  tongfen.cache_path = Sys.getenv("TONGFEN_CACHE_PATH"),
  nextzen_API_key = Sys.getenv("NEXTZEN_API_KEY")
)
```

## jdawangHelpers package

The `jdawangHelpers` package ([github.com/jdawang/jdawangHelpers](https://github.com/jdawang/jdawangHelpers)) contains reusable helpers for this blog. Always install it from GitHub, never from a local path:

```r
remotes::install_github("jdawang/jdawangHelpers")
```

Use its functions instead of writing equivalent code inline. Key exports:

**Themes**
- `theme_jd(mode)` — ggplot2 theme with dark/light mode, viridis magma palette, Source Sans Pro font
- `theme_map(mode)` — map-specific theme (no axes/grids, transparent panel)

**Plot layers**
- `layers_map_base(roads_type, mode)` — water + roads base layers for maps (wraps `mountainmathHelpers`)
- `layers_transit_ecdf(colour_var, x_max)` — ECDF step-plot layers for cumulative units by LRT distance

**GT table helpers**
- `opt_stylize_jd(data, mode)` — style a GT table to match `theme_jd()`
- `finalize_gt(gt_tbl, source, interactive)` — add source note, sub missing values, optional interactivity

**Building permits**
- `clean_edmonton_bp_columns(bp, crs)` — rename/clean columns from the Edmonton Open Data shapefile
- `filter_edmonton_residential(bp)` — filter to residential building types
- `add_edmonton_project_type(bp)` — classify permits into project type categories
- `add_edmonton_suite_info(bp)` — extract secondary suite counts and backyard home flags

**Neighbourhood classification**
- `add_edmonton_neighbourhood_type(bp)` — classify permits as Downtown/Mature/Between mature and Henday/Outside Henday (uses bundled `mature_neighbourhood` and `henday` spatial datasets)

**Transit**
- `load_edmonton_transit_stops(gtfs_path, ...)` — load Edmonton LRT stops from a GTFS zip
- `add_transit_distance(data, transit_stops)` — add `distance_from_lrt` column (km)
- `make_transit_buffers(transit_stops, radii_km)` — concentric buffer rings around stops
- `add_ecdf_by_distance(data, group_var, weight_var)` — compute weighted ECDF by transit distance

**Constants**
- `EDMONTON_RESIDENTIAL_BUILDING_TYPES` — character vector of residential building type strings
- `CAPTION_COE`, `CAPTION_COE_SC`, `CAPTION_TORONTO` — standard caption strings for plots/tables

## R package management

Posts have their own `renv.lock` for reproducibility. To restore packages for a specific post:

```bash
cd blog/2026/nodes-corridors
Rscript -e "renv::restore()"
```

When creating a new post, always:

- Initialize renv in its directory using `renv::init()`.
- Install required packages before trying to execute code.

If you come across an error like "[package name or function name] not found", that is most likely due to not installing the package. Install it and try again.

Before committing changes to a blog post, always run `renv::snapshot()` from within its directory to ensure the environment is saved.

## Freeze behaviour

Because `freeze: true` is set globally, rendered outputs are stored in `_freeze/` and reused. To force re-execution of a post's R code, change into the post's directory and rerender it with the `--no-freeze` option.

```bash
cd blog/2026/nodes-corridors/
quarto render blog/2026/nodes-corridors/index.qmd --no-freeze
```

The `blog/2022/election-maps-2022/index.qmd` is explicitly excluded from rendering in `_quarto.yml`.
