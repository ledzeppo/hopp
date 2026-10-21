import { guarded, json } from "../lib/auth";
import { config } from "../lib/config";
import { headOf, listKeys } from "../lib/store";
import { loadState } from "../lib/state";
import { pngSize } from "../lib/png";

export const GET = guarded(async () => {
  const [files, st] = await Promise.all([listKeys("designs/"), loadState()]);
  const designs = (
    await Promise.all(
      files
        .filter((f) => f.name.toLowerCase().endsWith(".png"))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (f) => {
          try {
            const [w, h] = pngSize(await headOf(f, "designs/"));
            return { name: f.name, w, h };
          } catch {
            return null;
          }
        }),
    )
  ).filter(Boolean);
  const items = Object.entries(st.products).map(([key, info]) => {
    const [design, bp] = [key.slice(0, key.lastIndexOf("|")), key.slice(key.lastIndexOf("|") + 1)];
    const product = config.products.find((p) => String(p.blueprint_id) === bp)?.name ?? bp;
    return { key, design, product, ...info };
  });
  return json({
    printify_key: !!process.env.PRINTIFY_TOKEN,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    ai_enabled: !!config.ai.enabled,
    model: config.ai.model,
    multiplier: config.price_multiplier,
    storage: process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "local",
    designs,
    products: config.products.map((p) => ({ blueprint_id: p.blueprint_id, name: p.name })),
    items,
  });
});
