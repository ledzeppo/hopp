import { config, Product } from "./config";

const API = "https://api.printify.com/v1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function call(method: string, path: string, body?: unknown, retries = 5): Promise<any> {
  const token = process.env.PRINTIFY_TOKEN;
  if (!token) throw new Error("Set PRINTIFY_TOKEN in the Vercel environment variables");
  for (let attempt = 0; attempt < retries; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "hopp" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ([429, 500, 502, 503].includes(r.status) && attempt < retries - 1) {
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
      continue;
    }
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : {};
  }
}

export async function shopId(): Promise<string> {
  if (process.env.PRINTIFY_SHOP_ID) return process.env.PRINTIFY_SHOP_ID;
  const shops = await call("GET", "/shops.json", undefined, 1);
  if (shops.length !== 1) throw new Error("Several Printify shops found; set PRINTIFY_SHOP_ID in Vercel");
  return String(shops[0].id);
}

type Variant = { id: number; options: Record<string, string>; placeholders: { position: string; width: number; height: number }[] };

const norm = (s: unknown) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const variantCache = new Map<string, Variant[]>();

export function selectVariants(variants: Variant[], filters: Record<string, string[]>, cap: number): Variant[] {
  let chosen = variants;
  for (const [key, allowed] of Object.entries(filters)) {
    const want = new Set(allowed.map(norm));
    const sub = chosen.filter((v) => want.has(norm(v.options[key] ?? "")));
    if (sub.length) chosen = sub;
  }
  return chosen.slice(0, cap);
}

export async function variantsFor(p: Product): Promise<Variant[]> {
  const key = `${p.blueprint_id}:${p.provider_id}`;
  if (!variantCache.has(key)) {
    const r = await call("GET", `/catalog/blueprints/${p.blueprint_id}/print_providers/${p.provider_id}/variants.json`);
    variantCache.set(key, selectVariants(r.variants, p.filters ?? {}, config.max_variants_per_product));
  }
  return variantCache.get(key)!;
}

export function buildPrintAreas(variants: Variant[], imageId: string, w: number, h: number, position = "front") {
  const groups = new Map<string, { w: number; h: number; ids: number[] }>();
  for (const v of variants) {
    const ph = v.placeholders.find((x) => x.position === position);
    if (!ph) continue;
    const k = `${ph.width}x${ph.height}`;
    if (!groups.has(k)) groups.set(k, { w: ph.width, h: ph.height, ids: [] });
    groups.get(k)!.ids.push(v.id);
  }
  return [...groups.values()].map((g) => ({
    variant_ids: g.ids,
    placeholders: [{
      position,
      images: [{ id: imageId, x: 0.5, y: 0.5, scale: Math.round(Math.min(1, (g.h / g.w) * (w / h)) * 1e4) / 1e4, angle: 0 }],
    }],
  }));
}

export const priceFor = (costCents: number) =>
  Math.floor((costCents * config.price_multiplier) / 100) * 100 + config.price_ending_cents;

export async function createProduct(
  sid: string, p: Product, variants: Variant[], imageId: string, w: number, h: number,
  title: string, description: string, tags: string[],
) {
  const areas = buildPrintAreas(variants, imageId, w, h);
  const used = areas.flatMap((a) => a.variant_ids);
  const prod = await call("POST", `/shops/${sid}/products.json`, {
    title, description, tags, blueprint_id: p.blueprint_id, print_provider_id: p.provider_id,
    variants: used.map((id) => ({ id, price: 1999, is_enabled: true })),
    print_areas: areas,
  });
  const costs = new Map<number, number>(prod.variants.map((v: any) => [v.id, v.cost ?? 0]));
  await call("PUT", `/shops/${sid}/products/${prod.id}.json`, {
    variants: used.map((id) => ({ id, is_enabled: true, price: priceFor(costs.get(id) ?? 0) })),
  });
  return prod;
}
