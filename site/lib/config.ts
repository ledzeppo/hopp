import cfg from "../config.json";

export type Product = {
  blueprint_id: number;
  provider_id: number;
  name: string;
  tags?: string[];
  filters?: Record<string, string[]>;
};

export const config = cfg as unknown as {
  price_multiplier: number;
  price_ending_cents: number;
  max_variants_per_product: number;
  title_template: string;
  description_template: string;
  common_tags: string[];
  products: Product[];
  ai: { enabled: boolean; model: string; effort: string; store_name: string; tone: string; audience: string };
};

export function pretty(stem: string): string {
  return stem.replace(/[_\-]+/g, " ").trim().replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
