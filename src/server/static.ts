/**
 * Serves the browser bundle. Files come from `Bun.embeddedFiles` in a compiled binary (when the
 * build embeds dist/public) and otherwise from `<repo>/dist/public` on disk. Extensionless GETs fall
 * back to index.html (SPA). Everything is `Cache-Control: no-cache` — names are stable, not hashed.
 */
import { resolve, normalize, extname } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
};

export const STATIC_DIR = resolve(import.meta.dir, "../../dist/public");

interface EmbeddedEntry {
  blob: Blob;
}

/** Embedded blobs by basename; `name-<hash>.ext` (bun's default asset naming) is mapped back to `name.ext`. */
function indexEmbedded(): Record<string, EmbeddedEntry> {
  const out: Record<string, EmbeddedEntry> = {};
  const files: Blob[] = Bun.embeddedFiles as Blob[];
  for (const blob of files) {
    const name = (blob as Blob & { name?: string }).name ?? "";
    if (!name) continue;
    const base = name.slice(name.lastIndexOf("/") + 1);
    out[base] = { blob };
    const m = /^(.+)-[a-z0-9]{8,}(\.[A-Za-z0-9]+)$/.exec(base);
    if (m && m[1] && m[2] && out[m[1] + m[2]] === undefined) out[m[1] + m[2]] = { blob };
  }
  return out;
}

export class StaticFiles {
  private readonly embedded: Record<string, EmbeddedEntry>;
  constructor(private readonly dir: string = STATIC_DIR) {
    this.embedded = indexEmbedded();
  }

  get usesEmbedded(): boolean {
    return Object.keys(this.embedded).length > 0;
  }

  private async lookup(relPath: string): Promise<Blob | null> {
    const base = relPath.slice(relPath.lastIndexOf("/") + 1);
    const e = this.embedded[base];
    if (e) return e.blob;
    const abs = resolve(this.dir, "." + relPath);
    if (!abs.startsWith(this.dir)) return null;
    const file = Bun.file(abs);
    if (!(await file.exists())) return null;
    return file;
  }

  /** Null when the path does not map to a file (so the caller can 404). */
  async serve(method: string, pathname: string): Promise<Response | null> {
    if (method !== "GET" && method !== "HEAD") return null;
    if (pathname.includes("\0") || pathname.includes("..")) return null;
    let rel = normalize(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    let blob = await this.lookup(rel);
    if (!blob && extname(rel) === "") blob = await this.lookup("/index.html");
    if (!blob) return null;
    const ext = extname(rel) === "" ? ".html" : extname(rel).toLowerCase();
    const headers = new Headers({
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": String(blob.size),
    });
    return new Response(method === "HEAD" ? null : blob, { headers });
  }
}
