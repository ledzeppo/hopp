import { ApiError, guarded, json } from "../lib/auth";
import { config, fill, pretty } from "../lib/config";
import { generateCopy } from "../lib/ai";
import { getBytes } from "../lib/store";
import { safeDesign } from "../lib/state";

export const POST = guarded(async (req) => {
  const body = await req.json();
  const name = safeDesign(body.design);
  const ids = new Set<number>((body.blueprint_ids ?? []).map(Number));
  const prods = config.products.filter((p) => ids.has(p.blueprint_id));
  if (!prods.length) throw new ApiError("No products selected");
  const png = await getBytes(`designs/${name}`);
  if (!png) throw new ApiError("Design not found", 404);

  if (config.ai.enabled && process.env.ANTHROPIC_API_KEY) {
    const { analysis, copy } = await generateCopy(name, png, prods);
    return json({ ai: true, design: analysis.name, summary: `${analysis.subject} (${analysis.style})`, copy });
  }
  const design = pretty(name.replace(/\.png$/i, ""));
  const copy: Record<number, unknown> = {};
  for (const p of prods) {
    const title = fill(config.title_template, { design, product: p.name });
    copy[p.blueprint_id] = {
      blueprint_id: p.blueprint_id, title,
      description_html: fill(config.description_template, { design, product: p.name }),
      meta_title: title.slice(0, 60), meta_description: `${title}. Printed on demand and shipped to you.`.slice(0, 160),
      tags: [...(p.tags ?? []), design.toLowerCase()], image_alt: title.slice(0, 125),
    };
  }
  return json({ ai: false, design, summary: "", copy });
});
