"""Generate SEO product copy for a design with Claude (vision + structured output).

To keep token use low, Claude writes the design-level parts once (blurb, tags, alt subject)
and only a short title, meta description and intro sentence per product. The rest of each
listing is assembled locally.
"""
import base64
import hashlib
import html
import io
import json
from pathlib import Path

from PIL import Image

from paths import DATA

CACHE_FILE = DATA / "copy_cache.json"
PROMPT_VERSION = "3"
LIMITS = {"title": 80, "meta_title": 60, "meta_description": 160, "image_alt": 125}

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["design", "products"],
    "properties": {
        "design": {
            "type": "object",
            "additionalProperties": False,
            "required": ["name", "subject", "style", "alt_subject", "blurb", "tags"],
            "properties": {
                "name": {"type": "string"},
                "subject": {"type": "string"},
                "style": {"type": "string"},
                "alt_subject": {"type": "string"},
                "blurb": {"type": "string"},
                "tags": {"type": "array", "items": {"type": "string"}},
            },
        },
        "products": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["blueprint_id", "title", "intro", "meta_description"],
                "properties": {
                    "blueprint_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "intro": {"type": "string"},
                    "meta_description": {"type": "string"},
                },
            },
        },
    },
}

SYSTEM = """You write SEO copy for a print-on-demand store. You see one design and a list of products
it will be printed on. Be concise.

design:
- name: a short searchable name for the design (2-5 words).
- subject, style: a few words each.
- alt_subject: a phrase describing the artwork for image alt text, e.g. "a striped orange sun behind navy mountains".
- blurb: 35-50 words about the design and who would love it. No product type in it, because it is reused on every product.
- tags: 8-10 lowercase search phrases about the design theme and gift occasions, not the product type.

each product:
- title: at most {title} characters. Start with the most searchable phrase (design plus product type). Natural wording, no keyword stuffing, no ALL CAPS, no emoji.
- intro: one sentence, at most 25 words, opening with the main keyword and naming the product.
- meta_description: 140-{meta_description} characters, one natural sentence mentioning design and product, ending with a soft call to action. No quotation marks.

The design is shown on a neutral grey backdrop added only for preview: never mention it or treat grey as part
of the design. Only state facts that follow from the product name or the image. Never invent materials,
sizes, product colours, or claims like "premium" or "eco-friendly". Return every product once, using the
blueprint_id you were given.
""".format(**LIMITS)


def _prep_image(path, max_edge=1024):
    img = Image.open(path).convert("RGBA")
    img.thumbnail((max_edge, max_edge))
    bg = Image.new("RGBA", img.size, (170, 170, 170, 255))  # neutral so light and dark art both read
    bg.alpha_composite(img)
    buf = io.BytesIO()
    bg.convert("RGB").save(buf, "JPEG", quality=85)
    return base64.standard_b64encode(buf.getvalue()).decode(), "image/jpeg"


def _cache_key(path, products, ai_cfg):
    h = hashlib.sha256(Path(path).read_bytes())
    h.update(PROMPT_VERSION.encode())
    sig = json.dumps([[p["blueprint_id"], p["name"]] for p in products]
                     + [ai_cfg.get(k, "") for k in ("model", "store_name", "tone", "audience")])
    h.update(sig.encode())
    return h.hexdigest()


def _cut(text, limit):
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:-– ")


def _violations(result, products):
    wanted = sorted(p["blueprint_id"] for p in products)
    if sorted(p["blueprint_id"] for p in result["products"]) != wanted:
        return [f"products must contain exactly these blueprint_ids once each: {wanted}"]
    return []  # over-long titles and meta descriptions are trimmed locally instead of paying for a retry


def _thinking_args(model):
    # Haiku 5.5 allows thinking to be switched off, which saves output tokens on a simple writing task.
    return {"thinking": {"type": "disabled"}} if model.startswith("claude-haiku-5-5") else {}


def _ask(client, ai_cfg, image_b64, media_type, products, feedback=None):
    model = ai_cfg.get("model", "claude-opus-5-5")
    listing = "\n".join(f'- {p["blueprint_id"]}: {p["name"]}' for p in products)
    text = "Products (blueprint_id: name):\n" + listing
    for label, key in (("Store name", "store_name"), ("Tone of voice", "tone"), ("Target audience", "audience")):
        if ai_cfg.get(key):
            text += f"\n{label}: {ai_cfg[key]}"
    if feedback:
        text += "\n\nYour previous answer broke these limits, fix them:\n" + "\n".join(feedback)
    resp = client.messages.create(
        model=model,
        max_tokens=8000,
        system=SYSTEM,
        output_config={"effort": ai_cfg.get("effort", "low"),
                       "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
            {"type": "text", "text": text}]}],
        **_thinking_args(model),
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined to write copy for this design")
    if resp.stop_reason == "max_tokens":
        raise RuntimeError("Claude's answer was cut off; reduce the number of products")
    result = json.loads(next(b.text for b in resp.content if b.type == "text"))
    result["_usage"] = {"input": resp.usage.input_tokens, "output": resp.usage.output_tokens}
    return result


def _assemble(result, products):
    """Build the full listing fields from Claude's short output."""
    d = result["design"]
    names = {p["blueprint_id"]: p["name"] for p in products}
    tags = [t.strip().lower() for t in d["tags"] if t.strip()]
    out = {}
    for p in result["products"]:
        name = names[p["blueprint_id"]]
        title = _cut(p["title"], LIMITS["title"])
        out[p["blueprint_id"]] = {
            "blueprint_id": p["blueprint_id"],
            "title": title,
            "description_html": f"<p>{html.escape(p['intro'].strip())}</p><p>{html.escape(d['blurb'].strip())}</p>",
            "meta_title": _cut(title, LIMITS["meta_title"]),
            "meta_description": _cut(p["meta_description"], LIMITS["meta_description"]),
            "tags": list(dict.fromkeys([name.lower()] + tags))[:13],
            "image_alt": _cut(f"{name} printed with {d['alt_subject']}", LIMITS["image_alt"]),
        }
    return out


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
        missing = {p["blueprint_id"] for p in products} - {p["blueprint_id"] for p in result["products"]}
        if missing:
            raise RuntimeError(f"Claude omitted blueprint ids {sorted(missing)}")
        cache[key] = result
        CACHE_FILE.write_text(json.dumps(cache, indent=2))
    result = cache[key]
    copy = _assemble(result, products)
    d = result["design"]
    return {"name": d["name"], "subject": d["subject"], "style": d["style"]}, copy
