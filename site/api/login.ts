import { checkPassword, json, sessionCookie, fail } from "../lib/auth";

export async function POST(req: Request): Promise<Response> {
  if (!process.env.APP_PASSWORD) return fail("Set APP_PASSWORD in the Vercel environment variables", 500);
  const body = await req.json().catch(() => ({}));
  if (!checkPassword(String(body.password ?? ""))) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return fail("Wrong password", 401);
  }
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie() });
}
