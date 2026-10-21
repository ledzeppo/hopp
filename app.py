#!/usr/bin/env python3
"""Local web interface for the bulk Printify tool. Run it, then open http://127.0.0.1:8765"""
import json
import mimetypes
import os
import re
import sys
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import printify_bulk as pb

ROOT = Path(__file__).parent
DESIGNS = ROOT / "designs"
THUMBS = DESIGNS / ".thumbs"
WEB = ROOT / "web"
PORT = int(os.environ.get("HOPP_PORT", "8765"))
LOCK = threading.Lock()
VARIANTS = {}  # (blueprint, provider) -> selected variants, cached per run


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def cfg():
    return json.loads((ROOT / "config.json").read_text())


def safe_design(name):
    name = Path(unquote(name)).name
    path = DESIGNS / name
    if not name.lower().endswith(".png") or not path.is_file():
        raise ApiError("Design not found")
    return path


def shop_id():
    pb.load_env()
    if not os.environ.get("PRINTIFY_TOKEN"):
        raise ApiError("Add your Printify token in Settings first")
    sid = os.environ.get("PRINTIFY_SHOP_ID")
    if sid:
        return sid
    shops = pb.call("GET", "/shops.json")
    if len(shops) != 1:
        raise ApiError("Several Printify shops found; set PRINTIFY_SHOP_ID in .env")
    return str(shops[0]["id"])


def variants_for(p, c):
    key = (p["blueprint_id"], p["provider_id"])
    if key not in VARIANTS:
        vs = pb.call("GET", f"/catalog/blueprints/{key[0]}/print_providers/{key[1]}/variants.json")["variants"]
        VARIANTS[key] = pb.select_variants(vs, p.get("filters", {}), c["max_variants_per_product"])
    return VARIANTS[key]


def template_copy(design, p, c):
    title = c["title_template"].format(design=design, product=p["name"])
    return {"blueprint_id": p["blueprint_id"], "title": title,
            "description_html": c["description_template"].format(design=design, product=p["name"]),
            "meta_title": title[:60], "meta_description": f"{title}. Printed on demand and shipped to you."[:160],
            "tags": list(dict.fromkeys(p.get("tags", []) + [design.lower()])), "image_alt": title[:125]}


# ---- API handlers ---------------------------------------------------------------------------

def status():
    pb.load_env()
    c = cfg()
    st = pb.load_state()
    designs = []
    for f in sorted(DESIGNS.glob("*.png")):
        w, h = pb.png_size(f)
        designs.append({"name": f.name, "w": w, "h": h})
    items = []
    for key, info in st["products"].items():
        fname, bp = key.rsplit("|", 1)
        name = next((p["name"] for p in c["products"] if p["blueprint_id"] == int(bp)), bp)
        items.append({"key": key, "design": fname, "product": name, **info})
    return {
        "printify_key": bool(os.environ.get("PRINTIFY_TOKEN")),
        "anthropic_key": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "ai_enabled": bool(c.get("ai", {}).get("enabled")),
        "model": c.get("ai", {}).get("model"),
        "multiplier": c["price_multiplier"],
        "designs": designs,
        "products": [{"blueprint_id": p["blueprint_id"], "name": p["name"]} for p in c["products"]],
        "items": items,
    }


def save_settings(d):
    env = ROOT / ".env"
    lines = env.read_text().splitlines() if env.exists() else []
    for k in ("PRINTIFY_TOKEN", "ANTHROPIC_API_KEY"):
        v = (d.get(k) or "").strip()
        if not v:
            continue
        if re.search(r"[\r\n]", v):
            raise ApiError("Invalid key")
        lines = [l for l in lines if not l.startswith(k + "=")] + [f"{k}={v}"]
        os.environ[k] = v
    env.write_text("\n".join(lines) + "\n")
    os.chmod(env, 0o600)
    return {"ok": True}


def make_copy(d):
    c = cfg()
    f = safe_design(d["design"])
    ids = {int(i) for i in d["blueprint_ids"]}
    prods = [p for p in c["products"] if p["blueprint_id"] in ids]
    design = pb.pretty(f.stem)
    ai = c.get("ai", {})
    if ai.get("enabled") and os.environ.get("ANTHROPIC_API_KEY"):
        from ai_copy import generate_copy
        analysis, copy = generate_copy(f, prods, ai)
        return {"ai": True, "design": analysis["name"], "summary": f"{analysis['subject']} ({analysis['style']})",
                "copy": {str(k): v for k, v in copy.items()}}
    return {"ai": False, "design": design, "summary": "",
            "copy": {str(p["blueprint_id"]): template_copy(design, p, c) for p in prods}}


def create(d):
    c = cfg()
    f = safe_design(d["design"])
    item = d["item"]
    p = next((x for x in c["products"] if x["blueprint_id"] == int(item["blueprint_id"])), None)
    if not p:
        raise ApiError("Unknown product")
    sid = shop_id()
    w, h = pb.png_size(f)
    with LOCK:
        st = pb.load_state()
        skey = f"{f.name}|{p['blueprint_id']}"
        if skey in st["products"]:
            raise ApiError("Already created")
        image_id = st["uploads"].get(f.name, {}).get("id")
        if not image_id:
            import base64
            up = pb.call("POST", "/uploads/images.json",
                         {"file_name": f.name, "contents": base64.b64encode(f.read_bytes()).decode()})
            image_id = up["id"]
            st["uploads"][f.name] = {"id": image_id}
            pb.save_state(st)
    tags = item.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    tags = list(dict.fromkeys(c["common_tags"] + p.get("tags", []) + tags))[:20]
    prod = pb.create_product(sid, c, p, variants_for(p, c), image_id, w, h,
                             item["title"].strip(), item["description_html"], tags)
    with LOCK:
        st = pb.load_state()
        st["products"][skey] = {"id": prod["id"], "title": item["title"].strip(), "published": False,
                                "meta_title": item.get("meta_title", ""),
                                "meta_description": item.get("meta_description", ""),
                                "image_alt": item.get("image_alt", "")}
        pb.save_state(st)
    return {"ok": True, "id": prod["id"]}


def publish(d):
    sid = shop_id()
    with LOCK:
        st = pb.load_state()
        info = st["products"].get(d["key"])
        if not info:
            raise ApiError("Unknown product")
    pb.call("POST", f"/shops/{sid}/products/{info['id']}/publish.json",
            {"title": True, "description": True, "images": True, "variants": True, "tags": True,
             "keyfeatures": True, "shipping_template": True})
    with LOCK:
        st = pb.load_state()
        st["products"][d["key"]]["published"] = True
        pb.save_state(st)
    return {"ok": True}


def delete(d):
    sid = shop_id()
    with LOCK:
        st = pb.load_state()
        info = st["products"].get(d["key"])
        if not info:
            raise ApiError("Unknown product")
    if info.get("published"):
        raise ApiError("Published products must be removed in Printify/Shopify directly")
    pb.call("DELETE", f"/shops/{sid}/products/{info['id']}.json")
    with LOCK:
        st = pb.load_state()
        st["products"].pop(d["key"], None)
        pb.save_state(st)
    return {"ok": True}


def thumb(name):
    from PIL import Image
    f = safe_design(name)
    THUMBS.mkdir(exist_ok=True)
    t = THUMBS / f.name
    if not t.exists() or t.stat().st_mtime < f.stat().st_mtime:
        im = Image.open(f).convert("RGBA")
        im.thumbnail((400, 400))
        im.save(t)
    return t.read_bytes()


POST_ROUTES = {"/api/settings": save_settings, "/api/copy": make_copy, "/api/create": create,
               "/api/publish": publish, "/api/delete": delete}


class Handler(BaseHTTPRequestHandler):
    server_version = "hopp"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, bytes):
            body = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _guard(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            self._send(403, {"error": "forbidden"})
            return False
        return True

    def do_GET(self):
        if not self._guard():
            return
        path = urlparse(self.path).path
        try:
            if path == "/api/status":
                return self._send(200, status())
            if path.startswith("/thumb/"):
                return self._send(200, thumb(path[7:]), "image/png")
            rel = "index.html" if path == "/" else path.lstrip("/")
            f = (WEB / rel).resolve()
            if WEB.resolve() in f.parents and f.is_file():
                return self._send(200, f.read_bytes(), mimetypes.guess_type(f.name)[0] or "text/plain")
            self._send(404, {"error": "not found"})
        except ApiError as e:
            self._send(e.code, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": str(e)})

    def do_POST(self):
        if not self._guard():
            return
        if self.headers.get("X-Hopp") != "1":  # blocks cross-site form posts
            return self._send(403, {"error": "forbidden"})
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n)
        try:
            if u.path == "/api/upload":
                name = Path(unquote(parse_qs(u.query).get("name", [""])[0])).name
                if not name.lower().endswith(".png") or not raw.startswith(b"\x89PNG"):
                    raise ApiError("Only PNG files are supported")
                name = re.sub(r"[^A-Za-z0-9._ -]", "_", name)
                DESIGNS.mkdir(exist_ok=True)
                (DESIGNS / name).write_bytes(raw)
                return self._send(200, {"ok": True, "name": name})
            fn = POST_ROUTES.get(u.path)
            if not fn:
                return self._send(404, {"error": "not found"})
            self._send(200, fn(json.loads(raw or b"{}")))
        except ApiError as e:
            self._send(e.code, {"error": str(e)})
        except Exception as e:
            self._send(500, {"error": str(e)[:600]})


def main():
    pb.load_env()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"Hopp is running at {url}  (press Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
