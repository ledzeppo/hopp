import { createHmac, timingSafeEqual } from "crypto";

const COOKIE = "hopp";

function token(): string {
  return createHmac("sha256", process.env.APP_PASSWORD || "").update("hopp-session-v1").digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isAuthed(req: Request): boolean {
  if (!process.env.APP_PASSWORD) return false;
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`));
  return !!m && safeEqual(m[1], token());
}

export function checkPassword(pw: string): boolean {
  return !!process.env.APP_PASSWORD && safeEqual(pw, process.env.APP_PASSWORD);
}

/** Short-lived signed link so Printify can fetch a design without logging in. */
export function signDownload(name: string, ttlSeconds = 900): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac("sha256", process.env.APP_PASSWORD || "").update(`dl:${name}:${exp}`).digest("hex");
  return `name=${encodeURIComponent(name)}&exp=${exp}&sig=${sig}`;
}

export function verifyDownload(name: string, exp: string, sig: string): boolean {
  if (!process.env.APP_PASSWORD || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const want = createHmac("sha256", process.env.APP_PASSWORD).update(`dl:${name}:${exp}`).digest("hex");
  return safeEqual(sig, want);
}

export function sessionCookie(): string {
  return `${COOKIE}=${token()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 30}`;
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

export function fail(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

/** Wrap a handler: login check, same-site check on writes, and friendly errors. */
export function guarded(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    if (!process.env.APP_PASSWORD) return fail("Set APP_PASSWORD in the Vercel environment variables", 500);
    if (!isAuthed(req)) return fail("Please log in", 401);
    if (req.method !== "GET" && req.headers.get("x-hopp") !== "1") return fail("forbidden", 403);
    try {
      return await fn(req);
    } catch (e: any) {
      return fail(friendly(e), e?.status && e.status < 600 ? e.status : 500);
    }
  };
}

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.status = status;
  }
}

export function friendly(e: any): string {
  const msg = String(e?.message || e);
  if (/ 401\b|Unauthenticated/.test(msg))
    return "Printify rejected the token. Check PRINTIFY_TOKEN in Vercel (create it with every permission ticked).";
  if (/ 403\b/.test(msg)) return "Printify refused this action. Make a new token with every permission ticked.";
  return msg.slice(0, 600);
}
