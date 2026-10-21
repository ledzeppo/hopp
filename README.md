# hopp: bulk Printify products from a folder of PNGs

## Easiest way: the web interface
Windows: double-click `start.bat`. Mac: double-click `start.command` (first time: right-click, Open).
Linux: `./start.command`. Your browser opens at http://127.0.0.1:8765. You need Python 3.10+ installed.
1. Click **Settings** and paste your Printify token and Anthropic key (saved only in `.env` on your computer).
2. Drop in your PNG designs and tick the products you want.
3. **Write listings** (Claude writes titles, descriptions, tags and SEO text; edit anything).
4. **Create drafts in Printify**, check the mockups, then **Publish** the ones you want on Shopify.

The page only listens on your own computer. The command-line tool below does the same job without the page.

Drop PNG designs into `designs/` and `printify_bulk.py` creates one Printify product per
design for each blueprint in `config.json` (2 tees, sweatshirt, hoodie, mug, tumbler, poster, canvas, phone
case, sticker, magnet, doormat, mouse pad, blanket, pillow, coaster, tote). Prices are 2x Printify's cost, rounded up to the next `$x.99`.

## AI-written SEO copy
For every design Claude looks at the image and writes, per product, an SEO title, HTML
description, tags, image alt text, meta title and meta description. The title, description and
tags go to Printify/Shopify; the meta title, meta description and alt text are saved in
`state.json` (Printify cannot set Shopify's SEO fields, so apply those after publishing).
Settings are in the `ai` block of `config.json` (model, store name, tone, audience). Results
are cached in `copy_cache.json`, so re-runs don't cost anything. Use `--no-ai` for the plain
templates. Needs `pip install -r requirements.txt` and `ANTHROPIC_API_KEY` in `.env`.

## Setup
1. Copy `.env.example` to `.env` and put your Printify and Anthropic keys in it (`.env` is gitignored).
2. Put PNGs in `designs/`. The file name becomes the product title (`sunset_wave.png` -> "Sunset Wave").
   Use large, transparent-background PNGs (4000px+ on the long side is ideal).

## Usage
```
python3 printify_bulk.py --dry-run          # preview, changes nothing
python3 printify_bulk.py --limit 1          # try one design first
python3 printify_bulk.py                    # create products in Printify (unpublished)
python3 printify_bulk.py --publish          # also push them to Shopify
python3 printify_bulk.py --only 6,77        # restrict to some blueprint ids
```
Products stay unpublished until you review them at https://printify.com/app/products and
then run with `--publish`. `state.json` records what was created, so re-running skips
finished work and only handles new designs. Delete an entry to recreate a product.

## Configuration (`config.json`)
- `products`: blueprint/provider ids, display name, tags, and `filters` that limit
  variants (colors, sizes). Provider `99` is Printify Choice (Printify picks the fulfilment partner).
- `price_multiplier`, `price_ending_cents`, `max_variants_per_product` (Printify/Shopify cap).
- `title_template`, `description_template`, `common_tags`.
- Find other blueprints with `GET /v1/catalog/blueprints.json`.

## Notes
- Designs are scaled to fit each print area without cropping; very different aspect ratios
  leave empty margins (posters especially).
- The script retries on rate limits (HTTP 429). Printify also limits how many products
  can be published per window, so very large batches may need to be run in chunks.
- Pricing ignores shipping; adjust the multiplier if you need to absorb it.
