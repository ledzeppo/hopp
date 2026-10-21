import { verifyDownload } from "../lib/auth";
import { getBytes } from "../lib/store";
import { safeDesign } from "../lib/state";

/** Signed, short-lived download used only so Printify can fetch an uploaded design. */
export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  let name: string;
  try {
    name = safeDesign(q.get("name"));
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!verifyDownload(name, q.get("exp") ?? "", q.get("sig") ?? "")) return new Response("link expired", { status: 403 });
  const bytes = await getBytes(`designs/${name}`);
  if (!bytes) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } });
}
