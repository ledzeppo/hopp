import { guarded, json, friendly } from "../lib/auth";
import { call } from "../lib/printify";

export const GET = guarded(async () => {
  try {
    const shops = await call("GET", "/shops.json", undefined, 1);
    if (!shops.length) return json({ ok: false, error: "Your Printify account has no shop yet." });
    return json({ ok: true, shop: shops[0].title, channel: shops[0].sales_channel ?? "" });
  } catch (e) {
    return json({ ok: false, error: friendly(e) });
  }
});
