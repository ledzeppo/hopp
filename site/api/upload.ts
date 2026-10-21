import { ApiError, guarded, json } from "../lib/auth";
import { getBytes, putBytes, removeKeys } from "../lib/store";
import { pngSize } from "../lib/png";
import { safeDesign } from "../lib/state";

/** Designs arrive in chunks under 4 MB because a serverless request body is limited to 4.5 MB. */
export const POST = guarded(async (req) => {
  const q = new URL(req.url).searchParams;
  const name = safeDesign(q.get("name"));
  const id = q.get("id") ?? "";
  const i = Number(q.get("i"));
  const n = Number(q.get("n"));
  if (!/^[a-z0-9]{8,32}$/.test(id) || !Number.isInteger(i) || !Number.isInteger(n) || n < 1 || n > 30 || i < 0 || i >= n)
    throw new ApiError("Bad upload request");
  const chunk = Buffer.from(await req.arrayBuffer());
  if (chunk.length > 4_400_000) throw new ApiError("Chunk too large");
  await putBytes(`tmp/${id}/${String(i).padStart(3, "0")}`, chunk);
  if (i < n - 1) return json({ ok: true, done: false });

  const parts: Buffer[] = [];
  for (let k = 0; k < n; k++) {
    const b = await getBytes(`tmp/${id}/${String(k).padStart(3, "0")}`);
    if (!b) throw new ApiError(`Upload is missing part ${k + 1} of ${n}. Please try again.`);
    parts.push(b);
  }
  const whole = Buffer.concat(parts);
  try {
    pngSize(whole);
  } catch {
    await removeKeys(`tmp/${id}/`);
    throw new ApiError("That file is not a PNG");
  }
  await putBytes(`designs/${name}`, whole, "image/png");
  await removeKeys(`tmp/${id}/`);
  return json({ ok: true, done: true, name });
});
