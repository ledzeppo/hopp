"""Generate SEO product copy for a design with Claude (vision + structured output)."""
import base64
import hashlib
import io
import json
from pathlib import Path

from PIL import Image

from paths import DATA

CACHE_FILE = DATA / "copy_cache.json"
PROMPT_VERSION = "2"
LIMITS = {"title": 80, "meta_title": 60, "meta_description": 160, "image_alt": 125}

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["design", "products"],
    "properties": {
        "design": {
            "type": "object",
            "additionalProperties": False,
            "required": ["name", "subject", "style", "colors", "mood", "keywords"],
            "properties": {
                "name": {"type": "string"},
                "subject": {"type": "string"},
                "style": {"type": "string"},
                "colors": {"type": "array", "items": {"type": "string"}},
                "mood": {"type": "string"},
                "keywords": {"type": "array", "items": {"type": "string"}},
            },
        },
        "products": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["blueprint_id", "title", "description_html", "meta_title",
                             "meta_description", "tags", "image_alt"],
                "properties": {
                    "blueprint_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "description_html": {"type": "string"},
                    "meta_title": {"type": "string"},
                    "meta_description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "image_alt": {"type": "string"},
                },
            },
        },
    },
}

SYSTEM = """You write SEO-optimised product copy for an online print-on-demand store.

You are shown one design and a list of products it will be printed on. First study the
design: subject, art style, colours, mood and likely buyer. Then write copy for every
product in the list.

Rules for each product:
- title: at most {title} characters. Lead with the most searchable phrase (what the design
  is plus the product type), natural wording, no keyword stuffing, no ALL CAPS, no emoji.
- meta_title: at most {meta_title} characters, includes the main keyword.
- meta_description: 140-{meta_description} characters, a natural sentence that mentions the design and
  product and ends with a soft call to action. No quotation marks.
- description_html: 80-160 words of simple HTML (<p>, <ul>, <li>, <strong> only). Open with
  the main keyword in the first sentence, describe the design and who it suits, then a short
  bullet list of benefits. Vary the wording between products, never copy-paste.
- tags: 8-13 lowercase search phrases mixing the design theme, product type and gift occasions.
- image_alt: at most {image_alt} characters describing the product with the design, for screen readers.

The design is shown on a neutral grey backdrop added only for preview: never mention the backdrop
or treat grey as part of the design. Do not state a product colour unless the product name gives one.

Factual limits: only state facts that follow from the product name or from the image. Do not
invent materials, sizes, thread counts, certifications, shipping times, or claims such as
"eco-friendly" or "premium quality" unless the product name says so. Do not mention any
brand names other than the store name if one is given. Do not describe the design as
original, licensed, or trademarked. Return every product exactly once, using the
blueprint_id you were given.
""".format(**LIMITS)


def _prep_image(path, max_edge=1568):
    img = Image.open(path).convert("RGBA")
    img.thumbnail((max_edge, max_edge))
    bg = Image.new("RGBA", img.size, (170, 170, 170, 255))  # neutral so light and dark art both read
    bg.alpha_composite(img)
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, "PNG", optimize=True)
    if buf.tell() > 4_900_000:
        buf = io.BytesIO()
        bg.convert("RGB").save(buf, "JPEG", quality=88)
        return base64.standard_b64encode(buf.getvalue()).decode(), "image/jpeg"
    return base64.standard_b64encode(buf.getvalue()).decode(), "image/png"


def _cache_key(path, products, ai_cfg):
    h = hashlib.sha256(Path(path).read_bytes())
    h.update(PROMPT_VERSION.encode())
    sig = json.dumps([[p["blueprint_id"], p["name"]] for p in products]
                     + [ai_cfg.get(k, "") for k in ("model", "store_name", "tone", "audience")])
    h.update(sig.encode())
    return h.hexdigest()


def _cut(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:-– ")


def _violations(result, products):
    bad = []
    wanted = sorted(p["blueprint_id"] for p in products)
    if sorted(p["blueprint_id"] for p in result["products"]) != wanted:
        bad.append(f"products must contain exactly these blueprint_ids once each: {wanted}")
    for p in result["products"]:
        for field, limit in LIMITS.items():
            if len(p[field]) > limit:
                bad.append(f"blueprint {p['blueprint_id']}: {field} is {len(p[field])} chars, max {limit}")
    return bad


def _ask(client, ai_cfg, image_b64, media_type, products, feedback=None):
    listing = "\n".join(f'- blueprint_id {p["blueprint_id"]}: {p["name"]}' for p in products)
    text = "Products this design will be printed on:\n" + listing
    for label, key in (("Store name", "store_name"), ("Tone of voice", "tone"), ("Target audience", "audience")):
        if ai_cfg.get(key):
            text += f"\n{label}: {ai_cfg[key]}"
    if feedback:
        text += "\n\nYour previous answer broke these limits, fix them:\n" + "\n".join(feedback)
    resp = client.messages.create(
        model=ai_cfg.get("model", "claude-opus-5-5"),
        max_tokens=16000,
        system=SYSTEM,
        output_config={"effort": ai_cfg.get("effort", "low"),
                       "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
            {"type": "text", "text": text}]}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined to write copy for this design")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off; reduce the number of products")
    return json.loads(next(b.text for b in resp.content if b.type == "text"))


def generate_copy(png_path, products, ai_cfg, client=None):
    """Return (design analysis, {blueprint_id: copy}). Results are cached on disk per design."""
    cache = json.loads(CACHE_FILE.read_text()) if CACHE_FILE.exists() else {}
    key = _cache_key(png_path, products, ai_cfg)
    if key not in cache:
        if client is None:
            import anthropic
            client = anthropic.Anthropic()
        image_b64, media_type = _prep_image(png_path)
        result = _ask(client, ai_cfg, image_b64, media_type, products)
        bad = _violations(result, products)
        if bad:
            result = _ask(client, ai_cfg, image_b64, media_type, products, feedback=bad)
        for p in result["products"]:  # last resort: trim rather than fail the whole batch
            for field, limit in LIMITS.items():
                p[field] = _cut(p[field], limit)
        got = {p["blueprint_id"] for p in result["products"]}
        missing = {p["blueprint_id"] for p in products} - got
        if missing:
            raise RuntimeError(f"Claude omitted blueprint ids {sorted(missing)}")
        cache[key] = result
        CACHE_FILE.write_text(json.dumps(cache, indent=2))
    result = cache[key]
    return result["design"], {p["blueprint_id"]: p for p in result["products"]}
