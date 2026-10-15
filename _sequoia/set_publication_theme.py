#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["cryptography>=45", "httpx>=0.28"]
# ///
"""Set ``basicTheme`` on the site.standard.publication record.

Sequoia 0.5.7 has no concept of ``site.standard.theme.basic`` at all - it is not in
``sequoia.schema.json``, and ``sequoia update`` only prompts for name / description /
url / icon / showInDiscover. Worse, if you ever do run that update flow, its
``updatePublication`` rebuilds the record from a fixed whitelist instead of spreading
the existing one, so it silently drops any field outside that whitelist - including a
``basicTheme`` set here. This script is the only way to set or restore it, by
hand-rolling the one ``com.atproto.repo.putRecord`` call sequoia itself doesn't make.

It reuses sequoia's own OAuth session (``~/.config/sequoia/oauth.json``, read-only)
rather than asking for separate credentials. That session is short-lived; if it has
expired, run any sequoia command first (``sequoia sync --dry-run`` is harmless) to
refresh it, then re-run this script.

    uv run --script _sequoia/set_publication_theme.py --check   # read-only
    uv run --script _sequoia/set_publication_theme.py --dry-run # build, don't send
    uv run --script _sequoia/set_publication_theme.py            # apply
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import time
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.asymmetric.ec import EllipticCurvePrivateKey

ROOT = Path(__file__).resolve().parent.parent
SEQUOIA_CONFIG = ROOT / "sequoia.json"
OAUTH_STORE = Path.home() / ".config" / "sequoia" / "oauth.json"

# Mirrors the site's light-mode palette:
#   background/foreground - cosmo's $body-bg / $body-color (custom_styles.scss sets
#     neither, so both fall through to the stock cosmo theme)
#   accent/accentForeground - $navbar-bg in custom_styles.scss (the brand plum) and
#     the white navbar text rendered on top of it
# Keep this in sync with custom_styles.scss; re-run this script if either changes.
THEME = {
    "background": (0xFF, 0xFF, 0xFF),
    "foreground": (0x34, 0x3A, 0x40),
    "accent": (0x66, 0x3F, 0x5F),
    "accentForeground": (0xFF, 0xFF, 0xFF),
}


def fail(msg: str) -> None:
    sys.exit(f"error: {msg}")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    padding = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def color_as_rgb(rgb: tuple[int, int, int]) -> dict:
    r, g, b = rgb
    return {"$type": "site.standard.theme.color#rgb", "r": r, "g": g, "b": b}


def build_basic_theme() -> dict:
    return {
        "$type": "site.standard.theme.basic",
        **{field: color_as_rgb(rgb) for field, rgb in THEME.items()},
    }


def parse_at_uri(uri: str) -> tuple[str, str, str]:
    # at://<did>/<collection>/<rkey>
    rest = uri.removeprefix("at://")
    did, collection, rkey = rest.split("/", 2)
    return did, collection, rkey


def resolve_pds(client: httpx.Client, did: str) -> str:
    """The did's current PDS service endpoint, straight from its DID document.

    Deliberately not reusing the OAuth session's ``aud`` for this: that field
    reflects the PDS as of the last login, and resolving independently is what
    makes ``--check`` genuinely credential-free.
    """
    if did.startswith("did:plc:"):
        response = client.get(f"https://plc.directory/{did}")
    elif did.startswith("did:web:"):
        host = did.removeprefix("did:web:").replace(":", "/")
        response = client.get(f"https://{host}/.well-known/did.json")
    else:
        fail(f"unsupported DID method: {did}")
    if response.status_code != 200:
        fail(f"could not resolve DID document for {did}: {response.status_code}")
    doc = response.json()
    for service in doc.get("service", []):
        if service.get("type") == "AtprotoPersonalDataServer":
            return service["serviceEndpoint"].rstrip("/")
    fail(f"no AtprotoPersonalDataServer service in DID document for {did}")


def load_publication_uri() -> str:
    config = json.loads(SEQUOIA_CONFIG.read_text())
    uri = config.get("publicationUri")
    if not uri:
        fail(f"no publicationUri in {SEQUOIA_CONFIG}")
    return uri


def load_oauth_session(did: str) -> dict:
    if not OAUTH_STORE.exists():
        fail(f"{OAUTH_STORE} not found - run `sequoia login` first")
    store = json.loads(OAUTH_STORE.read_text())
    session = store.get("sessions", {}).get(did)
    if not session:
        fail(f"no stored OAuth session for {did} in {OAUTH_STORE}")
    return session


def private_key_from_jwk(jwk: dict) -> EllipticCurvePrivateKey:
    if jwk.get("kty") != "EC" or jwk.get("crv") != "secp256k1":
        fail(f"unexpected DPoP key type: {jwk.get('kty')}/{jwk.get('crv')}")
    d = int.from_bytes(b64url_decode(jwk["d"]), "big")
    return ec.derive_private_key(d, ec.SECP256K1())


def public_jwk(jwk: dict) -> dict:
    # Only the public members belong in a DPoP proof's "jwk" header.
    return {"kty": jwk["kty"], "crv": jwk["crv"], "x": jwk["x"], "y": jwk["y"]}


def sign_es256k(private_key: EllipticCurvePrivateKey, signing_input: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes

    der_sig = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(der_sig)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def build_dpop_proof(
    private_key: EllipticCurvePrivateKey,
    jwk: dict,
    method: str,
    url: str,
    access_token: str | None = None,
    nonce: str | None = None,
) -> str:
    header = {"typ": "dpop+jwt", "alg": "ES256K", "jwk": public_jwk(jwk)}
    payload = {
        "iat": int(time.time()),
        "jti": secrets.token_urlsafe(16),
        "htm": method,
        # RFC 9449: htu excludes query and fragment.
        "htu": url.split("?", 1)[0].split("#", 1)[0],
    }
    if nonce:
        payload["nonce"] = nonce
    if access_token:
        payload["ath"] = b64url(hashlib.sha256(access_token.encode()).digest())

    signing_input = (
        b64url(json.dumps(header, separators=(",", ":")).encode())
        + "."
        + b64url(json.dumps(payload, separators=(",", ":")).encode())
    )
    signature = sign_es256k(private_key, signing_input.encode())
    return f"{signing_input}.{b64url(signature)}"


def check_session_fresh(session: dict) -> None:
    from datetime import datetime, timezone

    expires_at = session["tokenSet"].get("expires_at")
    if not expires_at:
        return
    expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    if expires <= datetime.now(timezone.utc):
        fail(
            "sequoia's OAuth session has expired. Run `sequoia sync --dry-run` "
            "(harmless, just refreshes the session), then re-run this script."
        )


def authed_put(
    client: httpx.Client,
    url: str,
    body: dict,
    *,
    private_key: EllipticCurvePrivateKey,
    jwk: dict,
    access_token: str,
) -> httpx.Response:
    """PUT with a DPoP proof, retrying once if the server demands a fresh nonce."""
    nonce = None
    for attempt in range(2):
        proof = build_dpop_proof(
            private_key, jwk, "POST", url, access_token=access_token, nonce=nonce
        )
        response = client.post(
            url,
            json=body,
            headers={
                "Authorization": f"DPoP {access_token}",
                "DPoP": proof,
            },
        )
        www_auth = response.headers.get("WWW-Authenticate", "")
        needs_nonce = response.status_code == 401 and "use_dpop_nonce" in www_auth
        fresh_nonce = response.headers.get("DPoP-Nonce")
        if needs_nonce and fresh_nonce and attempt == 0:
            nonce = fresh_nonce
            continue
        return response
    return response


def get_record(client: httpx.Client, pds: str, did: str, collection: str, rkey: str):
    response = client.get(
        f"{pds}/xrpc/com.atproto.repo.getRecord",
        params={"repo": did, "collection": collection, "rkey": rkey},
    )
    if response.status_code != 200:
        fail(f"getRecord failed ({response.status_code}): {response.text}")
    data = response.json()
    return data["value"], data["cid"]


def theme_matches(value: dict) -> bool:
    live = value.get("basicTheme")
    if not live:
        return False
    for field, rgb in THEME.items():
        color = live.get(field, {})
        if (color.get("r"), color.get("g"), color.get("b")) != rgb:
            return False
    return True


def print_theme(label: str, value: dict) -> None:
    theme = value.get("basicTheme")
    print(f"{label}:")
    if not theme:
        print("  (none)")
        return
    for field in THEME:
        color = theme.get(field, {})
        r, g, b = color.get("r"), color.get("g"), color.get("b")
        print(f"  {field:<17} #{r:02x}{g:02x}{b:02x}" if r is not None else f"  {field:<17} (missing)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="read-only: report whether the live record matches, no credentials needed",
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="authenticate and build the merged record, but don't write it",
    )
    args = parser.parse_args()

    publication_uri = load_publication_uri()
    did, collection, rkey = parse_at_uri(publication_uri)

    with httpx.Client(timeout=30) as client:
        pds = resolve_pds(client, did)
        # getRecord is a public read - no auth needed, and it also gives us the
        # swap CID for the write path below.
        value, cid = get_record(client, pds, did, collection, rkey)
        print_theme("live record", value)

        session = load_oauth_session(did) if not args.check else None

        if args.check:
            matches = theme_matches(value)
            print(f"\n{'matches' if matches else 'does NOT match'} the intended theme.")
            sys.exit(0 if matches else 1)

        check_session_fresh(session)

        merged = dict(value)
        merged["basicTheme"] = build_basic_theme()

        print()
        print_theme("merged record (about to write)" if not args.dry_run else "merged record (dry run)", merged)

        if args.dry_run:
            print("\n--dry-run: not writing.")
            return

        private_key = private_key_from_jwk(session["dpopJwk"])
        response = authed_put(
            client,
            f"{pds}/xrpc/com.atproto.repo.putRecord",
            {
                "repo": did,
                "collection": collection,
                "rkey": rkey,
                "record": merged,
                "swapRecord": cid,
            },
            private_key=private_key,
            jwk=session["dpopJwk"],
            access_token=session["tokenSet"]["access_token"],
        )
        if response.status_code != 200:
            fail(f"putRecord failed ({response.status_code}): {response.text}")

        print("\nwrote basicTheme to the publication record.")
        new_value, _ = get_record(client, pds, did, collection, rkey)
        print_theme("confirmed live record", new_value)
        if not theme_matches(new_value):
            fail("record was written but does not match on re-read - investigate")


if __name__ == "__main__":
    main()
