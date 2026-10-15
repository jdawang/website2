#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["pyyaml>=6", "pillow>=11"]
# ///
"""Build standard.site sidecar documents for sequoia from the rendered Quarto site.

Sequoia only globs ``**/*.md`` and builds ``textContent`` from the raw file body, so it
cannot read ``.qmd`` at all, and would miss every computed figure, table and inline R
value even if it could. This script sidesteps both problems: it writes one plain
markdown document per post into ``_sequoia/content/``, with metadata taken from the
Quarto source front matter and the body taken as plaintext from the *rendered* HTML.

Run after ``quarto render`` and before ``sequoia publish``:

    uv run --script _sequoia/build_documents.py
"""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import shutil
import sys
from io import BytesIO
from pathlib import Path

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "_site"
CONTENT = ROOT / "_sequoia" / "content"
STATE = ROOT / ".sequoia-state.json"
SEQUOIA_CONFIG = ROOT / "sequoia.json"

# sequoia's validatePost rejects any cover >= 1MB outright, and several of ours are
# multi-megabyte originals, so downscale into this budget.
COVER_MAX_BYTES = 900_000
COVER_MAX_WIDTH = 1200

# Non-greedy: Quarto emits exactly one <main> and never nests it, so stopping at the
# first </main> is correct and avoids swallowing anything that follows.
OG_IMAGE_RE = re.compile(r'<meta property="og:image" content="([^"]+)"')
MAIN_RE = re.compile(
    r'<main[^>]*id="quarto-document-content"[^>]*>(.*?)</main>', re.DOTALL
)
# Dropped wholesale: their text content is code or binary, never prose.
DROP_ELEMENTS = ("script", "style", "noscript", "svg")


def fail(msg: str) -> None:
    sys.exit(f"error: {msg}")


def post_paths() -> list[str]:
    """Blog post output paths, in listing order, from Quarto's own listing manifest."""
    manifest = SITE / "listings.json"
    if not manifest.exists():
        fail(f"{manifest} not found - run `quarto render` first")
    listings = json.loads(manifest.read_text())
    for listing in listings:
        if listing["listing"] == "/blog.html":
            return listing["items"]
    fail("no /blog.html listing in _site/listings.json")


def source_file(slug_dir: Path) -> Path:
    """The Quarto source for a post.

    ``.md`` wins over ``.qmd`` because that is what _quarto.yml renders where both
    exist (blog/2022/election-maps-2022 has its index.qmd explicitly excluded).
    """
    for name in ("index.md", "index.qmd"):
        candidate = ROOT / slug_dir / name
        if candidate.exists():
            return candidate
    fail(f"no index.md or index.qmd under {slug_dir}")


def read_front_matter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.DOTALL)
    if not match:
        fail(f"no YAML front matter in {path}")
    try:
        return yaml.safe_load(match.group(1)) or {}
    except yaml.YAMLError as exc:
        fail(f"cannot parse front matter in {path}: {exc}")


def cover_source(html_path: Path, site_url: str) -> str | None:
    """The cover Quarto actually chose for the post, as a path under _site.

    Reading og:image rather than the source front matter matters: most posts set no
    ``image:`` at all and Quarto picks the first figure from the rendered page, and the
    few that do set one may spell it site-absolute. Returns None for remote images.
    """
    match = OG_IMAGE_RE.search(html_path.read_text(encoding="utf-8"))
    if not match:
        return None
    url = match.group(1)
    return url.removeprefix(site_url).lstrip("/") if url.startswith(site_url) else None


def extract_text(html_path: Path) -> str:
    """Plaintext of the article body, per the lexicon's "no markdown" requirement."""
    source = html_path.read_text(encoding="utf-8")
    match = MAIN_RE.search(source)
    if not match:
        fail(f"no <main id=quarto-document-content> in {html_path}")
    body = match.group(1)
    for tag in DROP_ELEMENTS:
        body = re.sub(rf"<{tag}\b.*?</{tag}>", "", body, flags=re.DOTALL | re.IGNORECASE)
    text = html.unescape(re.sub(r"<[^>]+>", " ", body))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def normalize_date(value) -> str:
    """Render any of Quarto's date spellings as the ISO form sequoia's Date() wants."""
    if isinstance(value, dt.datetime):
        return value.isoformat()
    if isinstance(value, dt.date):
        return value.isoformat()
    if isinstance(value, str) and value.strip():
        return value.strip()
    fail(f"unusable date: {value!r}")


def build_cover(src: Path, dest: Path) -> int:
    """Copy the cover image to dest, downscaling until it fits the blob budget."""
    if src.stat().st_size <= COVER_MAX_BYTES and src.suffix.lower() in {".jpg", ".jpeg"}:
        shutil.copyfile(src, dest)
        return dest.stat().st_size

    with Image.open(src) as img:
        img = img.convert("RGB")
        if img.width > COVER_MAX_WIDTH:
            height = round(img.height * COVER_MAX_WIDTH / img.width)
            img = img.resize((COVER_MAX_WIDTH, height), Image.LANCZOS)
        for quality in (88, 80, 72, 64, 55, 45):
            buffer = BytesIO()
            img.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
            if buffer.tell() <= COVER_MAX_BYTES:
                dest.write_bytes(buffer.getvalue())
                return dest.stat().st_size
    fail(f"cannot fit {src} under {COVER_MAX_BYTES} bytes")


def render_document(meta: dict, body: str) -> str:
    """Serialize the sidecar.

    ``atUri`` is emitted last and quoted so the bytes match what sequoia itself writes
    via updateFrontmatterWithAtUri. The content hash it stores covers the whole file,
    so an identical layout is what keeps unchanged posts from being republished.
    """
    lines = ["---"]
    for key in ("title", "date", "description"):
        if meta.get(key):
            lines.append(f"{key}: {json.dumps(str(meta[key]), ensure_ascii=False)}")
    if meta.get("categories"):
        tags = ", ".join(json.dumps(str(t), ensure_ascii=False) for t in meta["categories"])
        lines.append(f"categories: [{tags}]")
    if meta.get("image"):
        lines.append(f"image: {meta['image']}")
    if meta.get("atUri"):
        lines.append(f'atUri: "{meta["atUri"]}"')
    lines.append("---")
    return "\n".join(lines) + "\n\n" + body + "\n"


def load_at_uris() -> dict[str, str]:
    """slug -> atUri for everything already published, so regenerating never re-creates."""
    if not STATE.exists():
        return {}
    state = json.loads(STATE.read_text())
    return {
        entry["slug"]: entry["atUri"]
        for entry in state.get("posts", {}).values()
        if entry.get("slug") and entry.get("atUri")
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report what would be written, without writing anything",
    )
    args = parser.parse_args()

    site_url = json.loads(SEQUOIA_CONFIG.read_text())["siteUrl"]
    at_uris = load_at_uris()
    warnings: list[str] = []
    rows: list[tuple[str, int, str]] = []

    if not args.check and CONTENT.exists():
        shutil.rmtree(CONTENT)

    for item in post_paths():
        # "/blog/2026/q3-building-permits/index.html" -> "blog/2026/q3-building-permits"
        slug = item.strip("/").rsplit("/", 1)[0]
        html_path = SITE / f"{slug}/index.html"
        if not html_path.exists():
            fail(f"{html_path} missing - is _site stale?")

        source = source_file(Path(slug))
        front = read_front_matter(source)
        body = extract_text(html_path)
        out_dir = CONTENT / slug

        meta = {
            "title": front.get("title"),
            "date": normalize_date(front.get("date")),
            "description": front.get("description"),
            "categories": front.get("categories") or [],
            "atUri": at_uris.get(slug),
        }
        if not meta["title"]:
            fail(f"{source} has no title")

        cover_note = "-"
        relative_cover = cover_source(html_path, site_url)
        if relative_cover is None:
            warnings.append(f"{slug}: no local cover image, publishing without one")
        else:
            cover_src = SITE / relative_cover
            if not cover_src.exists():
                warnings.append(f"{slug}: cover {relative_cover} missing from _site, skipping")
            elif args.check:
                cover_note = f"{cover_src.stat().st_size // 1024}K src"
            else:
                out_dir.mkdir(parents=True, exist_ok=True)
                size = build_cover(cover_src, out_dir / "cover.jpg")
                meta["image"] = f"{slug}/cover.jpg"
                cover_note = f"{size // 1024}K"

        if not args.check:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "index.md").write_text(render_document(meta, body), encoding="utf-8")

        rows.append((slug, len(body), cover_note))

    width = max(len(slug) for slug, _, _ in rows)
    for slug, length, cover in rows:
        marker = "+" if slug in at_uris else " "
        print(f"{marker} {slug:<{width}}  {length:>6} chars  cover {cover}")
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    verb = "would write" if args.check else "wrote"
    print(f"\n{verb} {len(rows)} documents to {CONTENT.relative_to(ROOT)}"
          f" ({len(at_uris)} already published)")


if __name__ == "__main__":
    main()
