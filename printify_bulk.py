#!/usr/bin/env python3
"""Create Printify products for every PNG in designs/ across the blueprints in config.json.

Products are created in Printify only (unpublished) so you can review them in the
Printify dashboard. Pass --publish to push them to the connected Shopify store.
"""
import argparse
import base64
import json
import os
import re
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
API = "https://api.printify.com/v1"
STATE_FILE = ROOT / "state.json"


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def call(method, path, body=None, retries=6):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(retries):
        req = urllib.request.Request(
            API + path, data=data, method=method,
            headers={"Authorization": "Bearer " + os.environ["PRINTIFY_TOKEN"],
                     "Content-Type": "application/json", "User-Agent": "hopp-bulk"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < retries - 1:
                time.sleep(min(60, 2 ** (attempt + 1)))
                continue
            raise RuntimeError(f"{method} {path} -> {e.code}: {e.read().decode()[:500]}")
    raise RuntimeError("unreachable")


def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def png_size(path):
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path.name} is not a PNG")
    return struct.unpack(">II", head[16:24])


def pretty(stem):
    return re.sub(r"[_\-]+", " ", stem).strip().title()


def load_state():
    return json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {"uploads": {}, "products": {}}


def save_state(st):
    STATE_FILE.write_text(json.dumps(st, indent=2))


def select_variants(variants, filters, cap):
    chosen = variants
    for key, allowed in filters.items():
        want = {norm(a) for a in allowed}
        sub = [v for v in chosen if norm(v["options"].get(key, "")) in want]
        if sub:
            chosen = sub
        else:
            print(f"  warning: no variants match {key}={allowed}; ignoring that filter")
    return chosen[:cap]


def build_print_areas(variants, image_id, img_w, img_h, position="front"):
    groups = {}
    for v in variants:
        ph = next((p for p in v["placeholders"] if p["position"] == position), None)
        if ph:
            groups.setdefault((ph["width"], ph["height"]), []).append(v["id"])
    areas = []
    for (w, h), ids in groups.items():
        scale = min(1.0, (h / w) * (img_w / img_h))  # fit inside area, keep aspect
        areas.append({"variant_ids": ids, "placeholders": [{
            "position": position,
            "images": [{"id": image_id, "x": 0.5, "y": 0.5, "scale": round(scale, 4), "angle": 0}]}]})
    return areas


def price_for(cost_cents, mult, ending):
    dollars = int(cost_cents * mult / 100)
    return dollars * 100 + ending


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--designs", default=str(ROOT / "designs"))
    ap.add_argument("--config", default=str(ROOT / "config.json"))
    ap.add_argument("--dry-run", action="store_true", help="show what would be created, change nothing")
    ap.add_argument("--limit", type=int, help="only process the first N designs")
    ap.add_argument("--only", help="comma-separated blueprint ids to process")
    ap.add_argument("--no-ai", action="store_true", help="use the plain templates instead of Claude-written SEO copy")
    ap.add_argument("--publish", action="store_true", help="publish created products to Shopify")
    args = ap.parse_args()

    load_env()
    if not os.environ.get("PRINTIFY_TOKEN"):
        sys.exit("Set PRINTIFY_TOKEN (see .env.example)")
    cfg = json.loads(Path(args.config).read_text())
    files = sorted(Path(args.designs).glob("*.png"))[: args.limit]
    if not files:
        sys.exit(f"No .png files in {args.designs}")
    only = {int(x) for x in args.only.split(",")} if args.only else None
    prods = [p for p in cfg["products"] if not only or p["blueprint_id"] in only]

    shop_id = os.environ.get("PRINTIFY_SHOP_ID")
    if not shop_id:
        shops = call("GET", "/shops.json")
        if len(shops) != 1:
            sys.exit("Multiple shops found; set PRINTIFY_SHOP_ID: " + ", ".join(f"{s['id']}={s['title']}" for s in shops))
        shop_id = str(shops[0]["id"])

    ai_cfg = cfg.get("ai", {})
    use_ai = ai_cfg.get("enabled") and not args.no_ai
    if use_ai and not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("AI copy is enabled but ANTHROPIC_API_KEY is not set (or run with --no-ai)")
    if use_ai:
        from ai_copy import generate_copy

    st = load_state()
    cap = cfg["max_variants_per_product"]
    catalog = {}
    for p in prods:
        key = (p["blueprint_id"], p["provider_id"])
        vs = call("GET", f"/catalog/blueprints/{key[0]}/print_providers/{key[1]}/variants.json")["variants"]
        catalog[key] = select_variants(vs, p.get("filters", {}), cap)
        print(f"{p['name']}: {len(catalog[key])} variants")

    created = 0
    failed = []
    for f in files:
        w, h = png_size(f)
        design = pretty(f.stem)
        image_id = st["uploads"].get(f.name, {}).get("id")
        if not image_id and not args.dry_run:
            print(f"Uploading {f.name} ({w}x{h})")
            up = call("POST", "/uploads/images.json",
                      {"file_name": f.name, "contents": base64.b64encode(f.read_bytes()).decode()})
            image_id = up["id"]
            st["uploads"][f.name] = {"id": image_id}
            save_state(st)
        copy = {}
        todo = [p for p in prods if f"{f.name}|{p['blueprint_id']}" not in st["products"]]
        if use_ai and todo:
            print(f"Writing SEO copy for {f.name} with Claude")
            analysis, copy = generate_copy(f, prods, ai_cfg)
            design = analysis["name"].strip().title() or design
            print(f"  seen: {analysis['subject']} ({analysis['style']})")
        for p in prods:
            skey = f"{f.name}|{p['blueprint_id']}"
            if skey in st["products"]:
                continue
            c = copy.get(p["blueprint_id"])
            variants = catalog[(p["blueprint_id"], p["provider_id"])]
            title = c["title"] if c else cfg["title_template"].format(design=design, product=p["name"])
            if args.dry_run:
                print(f"[dry-run] {title} ({len(variants)} variants)")
                continue
            try:
                areas = build_print_areas(variants, image_id, w, h)
                used = [i for a in areas for i in a["variant_ids"]]
                body = {
                    "title": title,
                    "description": c["description_html"] if c else cfg["description_template"].format(design=design, product=p["name"]),
                    "blueprint_id": p["blueprint_id"], "print_provider_id": p["provider_id"],
                    "tags": list(dict.fromkeys(cfg["common_tags"] + p.get("tags", []) + (c["tags"] if c else [design])))[:20],
                    "variants": [{"id": i, "price": 1999, "is_enabled": True} for i in used],
                    "print_areas": areas,
                }
                prod = call("POST", f"/shops/{shop_id}/products.json", body)
                costs = {v["id"]: v.get("cost", 0) for v in prod["variants"]}
                update = {"variants": [
                    {"id": i, "is_enabled": True,
                     "price": price_for(costs.get(i, 0), cfg["price_multiplier"], cfg["price_ending_cents"])}
                    for i in used]}
                call("PUT", f"/shops/{shop_id}/products/{prod['id']}.json", update)
            except Exception as e:
                failed.append((title, str(e)))
                print(f"FAILED {title}: {e}")
                continue
            st["products"][skey] = {"id": prod["id"], "title": title, "published": False}
            if c:
                st["products"][skey].update(meta_title=c["meta_title"], meta_description=c["meta_description"],
                                            image_alt=c["image_alt"])
            save_state(st)
            created += 1
            print(f"Created {title} -> {prod['id']}")
            time.sleep(0.5)

    if args.publish and not args.dry_run:
        for skey, info in st["products"].items():
            if info["published"]:
                continue
            call("POST", f"/shops/{shop_id}/products/{info['id']}/publish.json",
                 {"title": True, "description": True, "images": True, "variants": True, "tags": True,
                  "keyfeatures": True, "shipping_template": True})
            info["published"] = True
            save_state(st)
            print(f"Published {info['title']}")
            time.sleep(1)
    print(f"Done. {created} product(s) created, {len(failed)} failed.")
    for t, e in failed:
        print(f"  - {t}: {e[:200]}")


if __name__ == "__main__":
    main()
