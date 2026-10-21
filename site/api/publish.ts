import { ApiError, guarded, json } from "../lib/auth";
import { call, shopId } from "../lib/printify";
import { loadState, saveState } from "../lib/state";

export const POST = guarded(async (req) => {
  const { key } = await req.json();
  const sid = await shopId();
  const info = (await loadState()).products[key];
  if (!info) throw new ApiError("Unknown product");
  await call("POST", `/shops/${sid}/products/${info.id}/publish.json`, {
    title: true, description: true, images: true, variants: true, tags: true, keyfeatures: true, shipping_template: true,
  });
  const st = await loadState();
  st.products[key].published = true;
  await saveState(st);
  return json({ ok: true });
});
