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
