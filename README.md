# hopp: bulk Printify products from a folder of PNGs

Drop PNG designs into `designs/` and `printify_bulk.py` creates one Printify product per
design for each blueprint in `config.json` (tees, sweatshirts, hoodie, mug, poster, phone
case, sticker). Prices are 2x Printify's cost, rounded up to the next `$x.99`.

## Setup
1. Copy `.env.example` to `.env` and put your Printify token in it (`.env` is gitignored).
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
