import { ApiError, guarded, json } from "../lib/auth";
import { call, shopId } from "../lib/printify";
import { loadState, saveState } from "../lib/state";

export const POST = guarded(async (req) => {
  const { key } = await req.json();
  const sid = await shopId();
  const info = (await loadState()).products[key];
  if (!info) throw new ApiError("Unknown product");
  if (info.published) throw new ApiError("Published products must be removed in Printify or Shopify directly");
  await call("DELETE", `/shops/${sid}/products/${info.id}.json`);
  const st = await loadState();
  delete st.products[key];
  await saveState(st);
  return json({ ok: true });
});
