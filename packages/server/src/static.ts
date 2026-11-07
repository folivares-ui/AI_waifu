import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".vrm": "model/gltf-binary",
  ".glb": "model/gltf-binary",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serves the built web app (apps/web/dist). Returns false if the request is not for a static file.
 * `isProtected(path)` lets the caller require authentication for personal assets (the avatar model).
 */
export function createStaticHandler(dir: string, isProtected: (path: string) => boolean, authorized: (req: IncomingMessage) => boolean) {
  const root = resolve(dir);
  return function serve(req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end();
      return true;
    }
    if (rel.includes("\0")) {
      res.writeHead(400).end();
      return true;
    }
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) {
      res.writeHead(403).end(); // path traversal attempt
      return true;
    }
    const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
    if (!isFile(file)) {
      // Single-page app: unknown paths without an extension get index.html.
      if (extname(rel)) return false;
      file = join(root, "index.html");
      if (!isFile(file)) return false;
    }
    if (isProtected(pathname) && !authorized(req)) {
      res.writeHead(403, { "content-type": "application/json" }).end('{"error":"forbidden"}');
      return true;
    }
    const ext = extname(file);
    const immutable = /^\/assets\//.test(pathname);
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "content-length": statSync(file).size,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
    return true;
  };
}
