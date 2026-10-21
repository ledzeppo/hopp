/** Storage: Vercel Blob in production (private or public store, detected automatically), a local folder otherwise. */
import { promises as fs } from "fs";
import path from "path";
import { put, list, del, get } from "@vercel/blob";

export const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;
const LOCAL = path.join(process.cwd(), ".data");

export type DesignFile = { name: string; size: number };
type Access = "private" | "public";

let known: Access | undefined; // learned from the first call, then reused

const isAccessMismatch = (e: any) => /access/i.test(String(e?.message)) && /store/i.test(String(e?.message));

async function withAccess<T>(fn: (access: Access) => Promise<T>): Promise<T> {
  const order: Access[] = known ? [known] : ["private", "public"];
  let last: unknown;
  for (const access of order) {
    try {
      const r = await fn(access);
      known = access;
      return r;
    } catch (e) {
      last = e;
      if (!isAccessMismatch(e)) throw e;
    }
  }
  throw last;
}

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

async function readBlob(pathname: string, maxBytes?: number): Promise<Buffer | null> {
  const r = await withAccess((access) => get(pathname, { access, useCache: false }));
  if (!r || !r.stream) return null;
  const reader = r.stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.length;
    if (maxBytes && total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  return Buffer.concat(chunks);
}

export async function putBytes(key: string, bytes: Buffer, contentType = "application/octet-stream"): Promise<void> {
  if (useBlob()) {
    await withAccess((access) => put(key, bytes, { access, addRandomSuffix: false, allowOverwrite: true, contentType }));
    return;
  }
  const f = path.join(LOCAL, key);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, bytes);
}

export async function listKeys(prefix: string): Promise<DesignFile[]> {
  if (useBlob()) return (await listAll(prefix)).map((b) => ({ name: b.pathname.slice(prefix.length), size: b.size }));
  const dir = path.join(LOCAL, prefix);
  try {
    const names = await fs.readdir(dir);
    return await Promise.all(names.map(async (n) => ({ name: n, size: (await fs.stat(path.join(dir, n))).size })));
  } catch {
    return [];
  }
}

export async function getBytes(key: string): Promise<Buffer | null> {
  if (useBlob()) return readBlob(key);
  try {
    return await fs.readFile(path.join(LOCAL, key));
  } catch {
    return null;
  }
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
  if (useBlob()) {
    const blobs = (await listAll(`state/${name}-`)).sort((a, b) => +b.uploadedAt - +a.uploadedAt);
    if (!blobs.length) return fallback;
    const buf = await readBlob(blobs[0].pathname);
    return buf ? (JSON.parse(buf.toString("utf8")) as T) : fallback;
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
    const key = `state/${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    await putBytes(key, body, "application/json");
    const stale = old.filter((b) => b.pathname !== key);
    if (stale.length) await del(stale.map((b) => b.url));
  } else {
    await fs.mkdir(path.join(LOCAL, "state"), { recursive: true });
    await fs.writeFile(path.join(LOCAL, `state/${name}.json`), body);
  }
}

/** First 32 bytes of a stored file (enough to read a PNG header). */
export async function headOf(d: DesignFile, prefix: string): Promise<Buffer> {
  if (useBlob()) {
    const b = await readBlob(prefix + d.name, 32);
    if (!b) throw new Error("File not found");
    return b.subarray(0, 32);
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
