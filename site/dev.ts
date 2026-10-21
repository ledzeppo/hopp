/** Local stand-in for Vercel: serves public/ and runs the files in api/. Used for tests only. */
import http from "http";
import fs from "fs";
import path from "path";

const PORT = Number(process.env.PORT || 3000);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
      try {
        const mod = require(`./api/${name}`);
        const fn = mod[req.method || "GET"];
        if (!fn) throw new Error("no handler");
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks);
        const r: Response = await fn(
          new Request(url, {
            method: req.method,
            headers: req.headers as Record<string, string>,
            body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
          }),
        );
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => (headers[k] = v));
        res.writeHead(r.status, headers);
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch (e: any) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      }
      return;
    }
    const f = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
    if (f.startsWith(path.join(__dirname, "public")) && fs.existsSync(f) && fs.statSync(f).isFile()) {
      res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : "application/octet-stream" });
      res.end(fs.readFileSync(f));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  })
  .listen(PORT, () => console.log(`dev server on http://localhost:${PORT}`));
