import { ApiError, guarded, json, signDownload } from "../lib/auth";
import { config } from "../lib/config";
import { createProduct, call, shopId, variantsFor } from "../lib/printify";
import { getBytes, listKeys, headOf, useBlob } from "../lib/store";
import { loadState, safeDesign, saveState } from "../lib/state";
import { pngSize } from "../lib/png";

export const POST = guarded(async (req) => {
  const { design, item } = await req.json();
  const name = safeDesign(design);
  const p = config.products.find((x) => x.blueprint_id === Number(item?.blueprint_id));
  if (!p) throw new ApiError("Unknown product");
  const title = String(item.title ?? "").trim();
  if (!title) throw new ApiError("Title is empty");
  const sid = await shopId();

  const file = (await listKeys("designs/")).find((f) => f.name === name);
  if (!file) throw new ApiError("Design not found", 404);
  const [w, h] = pngSize(await headOf(file, "designs/"));

  let st = await loadState();
  const skey = `${name}|${p.blueprint_id}`;
  if (st.products[skey]) throw new ApiError("Already created");

  let imageId = st.uploads[name]?.id;
  if (!imageId) {
    const host = req.headers.get("x-forwarded-host") || new URL(req.url).host;
    const origin = `${req.headers.get("x-forwarded-proto") || "https"}://${host}`;
    const canUseUrl = useBlob() && !/^(localhost|127\.)/.test(host);
    const viaBase64 = async () => ({ file_name: name, contents: (await getBytes(`designs/${name}`))!.toString("base64") });
    let up: any;
    if (canUseUrl) {
      try {
        up = await call("POST", "/uploads/images.json", { file_name: name, url: `${origin}/api/dl?${signDownload(name)}` });
      } catch {
        up = await call("POST", "/uploads/images.json", await viaBase64());
      }
    } else {
      up = await call("POST", "/uploads/images.json", await viaBase64());
    }
    imageId = up.id as string;
    st = await loadState();
    st.uploads[name] = { id: imageId };
    await saveState(st);
  }

  const tags = (typeof item.tags === "string" ? item.tags.split(",") : item.tags ?? [])
    .map((t: string) => t.trim()).filter(Boolean);
  const allTags = [...new Set([...config.common_tags, ...(p.tags ?? []), ...tags])].slice(0, 20);
  const prod = await createProduct(sid, p, await variantsFor(p), imageId, w, h, title, String(item.description_html ?? ""), allTags);

  st = await loadState();
  st.products[skey] = {
    id: prod.id, title, published: false,
    meta_title: item.meta_title ?? "", meta_description: item.meta_description ?? "", image_alt: item.image_alt ?? "",
  };
  await saveState(st);
  return json({ ok: true, id: prod.id });
});
