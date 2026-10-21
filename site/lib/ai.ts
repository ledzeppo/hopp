import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import { createHash } from "crypto";
import { config, Product } from "./config";
import { getJson, putJson } from "./store";

const PROMPT_VERSION = "3";
const LIMITS = { title: 80, meta_title: 60, meta_description: 160, image_alt: 125 };

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["design", "products"],
  properties: {
    design: {
      type: "object",
      additionalProperties: false,
      required: ["name", "subject", "style", "alt_subject", "blurb", "tags"],
      properties: {
        name: { type: "string" }, subject: { type: "string" }, style: { type: "string" },
        alt_subject: { type: "string" }, blurb: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blueprint_id", "title", "intro", "meta_description"],
        properties: {
          blueprint_id: { type: "integer" }, title: { type: "string" },
          intro: { type: "string" }, meta_description: { type: "string" },
        },
      },
    },
  },
};

const SYSTEM = `You write SEO copy for a print-on-demand store. You see one design and a list of products
it will be printed on. Be concise.

design:
- name: a short searchable name for the design (2-5 words).
- subject, style: a few words each.
- alt_subject: a phrase describing the artwork for image alt text, e.g. "a striped orange sun behind navy mountains".
- blurb: 35-50 words about the design and who would love it. No product type in it, because it is reused on every product.
- tags: 8-10 lowercase search phrases about the design theme and gift occasions, not the product type.

each product:
- title: at most ${LIMITS.title} characters. Start with the most searchable phrase (design plus product type). Natural wording, no keyword stuffing, no ALL CAPS, no emoji.
- intro: one sentence, at most 25 words, opening with the main keyword and naming the product.
- meta_description: 140-${LIMITS.meta_description} characters, one natural sentence mentioning design and product, ending with a soft call to action. No quotation marks.

The design is shown on a neutral grey backdrop added only for preview: never mention it or treat grey as part
of the design. Only state facts that follow from the product name or the image. Never invent materials,
sizes, product colours, or claims like "premium" or "eco-friendly". Return every product once, using the
blueprint_id you were given.`;

const cut = (t: string, n: number) => {
  t = t.trim();
  return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "").replace(/[,;:\-– ]+$/, "");
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function prepImage(png: Buffer): Promise<string> {
  const jpg = await sharp(png)
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#aaaaaa" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return jpg.toString("base64");
}

async function ask(png: Buffer, products: Product[]) {
  const client = new Anthropic();
  const ai = config.ai;
  const lines = products.map((p) => `- ${p.blueprint_id}: ${p.name}`).join("\n");
  let text = "Products (blueprint_id: name):\n" + lines;
  if (ai.store_name) text += `\nStore name: ${ai.store_name}`;
  if (ai.tone) text += `\nTone of voice: ${ai.tone}`;
  if (ai.audience) text += `\nTarget audience: ${ai.audience}`;
  const params: any = {
    model: ai.model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: { effort: ai.effort || "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: await prepImage(png) } },
        { type: "text", text },
      ],
    }],
  };
  if (ai.model.startsWith("claude-haiku-5-5")) params.thinking = { type: "disabled" };
  const resp: any = await client.messages.create(params);
  if (resp.stop_reason === "refusal") throw new Error("Claude declined to write copy for this design");
  if (resp.stop_reason === "max_tokens") throw new Error("Claude's answer was cut off; select fewer products");
  const block = resp.content.find((b: any) => b.type === "text");
  const result = JSON.parse(block.text);
  result._usage = { input: resp.usage.input_tokens, output: resp.usage.output_tokens };
  return result;
}

export type Copy = {
  blueprint_id: number; title: string; description_html: string; meta_title: string;
  meta_description: string; tags: string[]; image_alt: string;
};

function assemble(result: any, products: Product[]): Record<number, Copy> {
  const d = result.design;
  const names = new Map(products.map((p) => [p.blueprint_id, p.name]));
  const tags: string[] = d.tags.map((t: string) => t.trim().toLowerCase()).filter(Boolean);
  const out: Record<number, Copy> = {};
  for (const p of result.products) {
    const name = names.get(p.blueprint_id);
    if (!name) continue;
    const title = cut(p.title, LIMITS.title);
    out[p.blueprint_id] = {
      blueprint_id: p.blueprint_id,
      title,
      description_html: `<p>${esc(p.intro.trim())}</p><p>${esc(d.blurb.trim())}</p>`,
      meta_title: cut(title, LIMITS.meta_title),
      meta_description: cut(p.meta_description, LIMITS.meta_description),
      tags: [...new Set([name.toLowerCase(), ...tags])].slice(0, 13),
      image_alt: cut(`${name} printed with ${d.alt_subject}`, LIMITS.image_alt),
    };
  }
  return out;
}

export async function generateCopy(designName: string, png: Buffer, products: Product[]) {
  const key = createHash("sha256")
    .update(JSON.stringify([designName, png.length, PROMPT_VERSION, config.ai.model, config.ai.store_name, config.ai.tone,
      config.ai.audience, products.map((p) => [p.blueprint_id, p.name])]))
    .digest("hex");
  const cache = await getJson<Record<string, any>>("copy-cache", {});
  let result = cache[key];
  if (!result) {
    result = await ask(png, products);
    const got = result.products.map((p: any) => p.blueprint_id).sort();
    const want = products.map((p) => p.blueprint_id).sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) result = await ask(png, products);
    cache[key] = result;
    await putJson("copy-cache", cache);
  }
  const copy = assemble(result, products);
  const missing = products.filter((p) => !copy[p.blueprint_id]);
  if (missing.length) throw new Error(`Claude omitted: ${missing.map((p) => p.name).join(", ")}`);
  const d = result.design;
  return { analysis: { name: d.name, subject: d.subject, style: d.style }, copy };
}
