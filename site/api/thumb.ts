import sharp from "sharp";
import { ApiError, guarded } from "../lib/auth";
import { getBytes } from "../lib/store";
import { safeDesign } from "../lib/state";

export const GET = guarded(async (req) => {
  const name = safeDesign(new URL(req.url).searchParams.get("name"));
  const bytes = await getBytes(`designs/${name}`);
  if (!bytes) throw new ApiError("Design not found", 404);
  const png = await sharp(bytes).resize(400, 400, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400" } });
});
