/** Storage: Vercel Blob in production, a local folder when BLOB_READ_WRITE_TOKEN is not set (dev/tests). */
import { promises as fs } from "fs";
import path from "path";
import { put, list, del } from "@vercel/blob";

const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL = path.join(process.cwd(), ".data");

export type DesignFile = { name: string; url?: string; size: number };

const opts = { access: "public" as const, addRandomSuffix: false, allowOverwrite: true };

async function listAll(prefix: string) {
  const out: { pathname: string; url: string; size: number; uploadedAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const r = await list({ prefix, cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

export async function putBytes(key: string, bytes: Buffer, contentType = "application/octet-stream"): Promise<string | undefined> {
  if (useBlob()) return (await put(key, bytes, { ...opts, contentType })).url;
  const f = path.join(LOCAL, key);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, bytes);
}

export async function listKeys(prefix: string): Promise<DesignFile[]> {
  if (useBlob()) return (await listAll(prefix)).map((b) => ({ name: b.pathname.slice(prefix.length), url: b.url, size: b.size }));
  const dir = path.join(LOCAL, prefix);
  try {
    const names = await fs.readdir(dir);
    return await Promise.all(names.map(async (n) => ({ name: n, size: (await fs.stat(path.join(dir, n))).size })));
  } catch {
    return [];
  }
}

export async function getBytes(key: string): Promise<Buffer | null> {
  if (useBlob()) {
    const hit = (await listAll(key)).find((b) => b.pathname === key);
    if (!hit) return null;
    const r = await fetch(hit.url + "?t=" + Date.now(), { cache: "no-store" });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }
  try {
    return await fs.readFile(path.join(LOCAL, key));
  } catch {
    return null;
  }
}

export async function publicUrl(key: string): Promise<string | undefined> {
  if (!useBlob()) return undefined;
  return (await listAll(key)).find((b) => b.pathname === key)?.url;
}

export async function removeKeys(prefix: string): Promise<void> {
  if (useBlob()) {
    const urls = (await listAll(prefix)).map((b) => b.url);
    if (urls.length) await del(urls);
  } else {
    await fs.rm(path.join(LOCAL, prefix), { recursive: true, force: true });
  }
}

/** JSON documents are written under a new name each time (and the old ones removed), so reads are never stale. */
export async function getJson<T>(name: string, fallback: T): Promise<T> {
  const prefix = `state/${name}-`;
  if (useBlob()) {
    const blobs = (await listAll(prefix)).sort((a, b) => +b.uploadedAt - +a.uploadedAt);
    if (!blobs.length) return fallback;
    const r = await fetch(blobs[0].url, { cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : fallback;
  }
  try {
    return JSON.parse(await fs.readFile(path.join(LOCAL, `state/${name}.json`), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function putJson(name: string, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  if (useBlob()) {
    const old = await listAll(`state/${name}-`);
    await put(`state/${name}-${Date.now()}.json`, body, { ...opts, addRandomSuffix: false, contentType: "application/json" });
    if (old.length) await del(old.map((b) => b.url));
  } else {
    await fs.mkdir(path.join(LOCAL, "state"), { recursive: true });
    await fs.writeFile(path.join(LOCAL, `state/${name}.json`), body);
  }
}

/** First 32 bytes of a stored file (enough to read a PNG header). */
export async function headOf(d: DesignFile, prefix: string): Promise<Buffer> {
  if (d.url) {
    const r = await fetch(d.url, { headers: { Range: "bytes=0-31" }, cache: "no-store" });
    return Buffer.from(await r.arrayBuffer()).subarray(0, 32);
  }
  const fh = await fs.open(path.join(LOCAL, prefix, d.name), "r");
  try {
    const buf = Buffer.alloc(32);
    await fh.read(buf, 0, 32, 0);
    return buf;
  } finally {
    await fh.close();
  }
}
