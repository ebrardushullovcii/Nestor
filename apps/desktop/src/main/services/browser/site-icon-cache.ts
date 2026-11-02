import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  SITE_ICON_MAX_BYTES,
  siteIconOrigin,
  type SiteIconType,
} from "@nestor/contracts";

/**
 * Job sites' own icons, kept in a folder in the app's data so a site's icon
 * shows offline and after a restart. One small JSON file per origin. Only
 * image bytes that read as a raster icon (PNG, ICO, GIF, JPEG, WebP) and fit
 * in {@link SITE_ICON_MAX_BYTES} are stored; the renderer gets them as data
 * URLs through the typed bridge, never as file paths.
 */

/** Most icons kept; the oldest go first past this. */
export const SITE_ICON_CACHE_MAX_ENTRIES = 500;
/** An icon is looked up again on a visit after this long. */
export const SITE_ICON_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** A site whose icon could not be fetched is not asked again for this long. */
const SITE_ICON_RETRY_MS = 60 * 60 * 1000;

interface StoredIcon {
  origin: string;
  type: SiteIconType;
  data: string;
  savedAt: number;
}

/** The image type the bytes themselves say they are, or null. */
export function sniffSiteIconType(bytes: Uint8Array): SiteIconType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (offset: number, text: string) =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  // ICO: reserved 0, type 1, and at least one image in the directory.
  if (starts(0x00, 0x00, 0x01, 0x00) && (bytes[4] ?? 0) + (bytes[5] ?? 0) > 0)
    return "image/x-icon";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

/** Checked icon bytes, or null when they are not a small raster image. */
export function checkSiteIcon(
  bytes: Uint8Array,
): { type: SiteIconType; bytes: Uint8Array } | null {
  if (bytes.byteLength === 0 || bytes.byteLength > SITE_ICON_MAX_BYTES)
    return null;
  const type = sniffSiteIconType(bytes);
  return type ? { type, bytes } : null;
}

export class SiteIconCache {
  private readonly memory = new Map<string, StoredIcon | null>();
  private readonly failedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private ready: Promise<void> | null = null;

  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}

  private fileFor(origin: string): string {
    const name = createHash("sha256").update(origin).digest("hex").slice(0, 32);
    return path.join(this.directory, `${name}.json`);
  }

  /** Reads every stored icon once, on first use. */
  private load(): Promise<void> {
    this.ready ??= (async () => {
      let names: string[] = [];
      try {
        names = await readdir(this.directory);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
          .map(async (name) => {
            try {
              const stored = JSON.parse(
                await readFile(path.join(this.directory, name), "utf8"),
              ) as Partial<StoredIcon>;
              const origin =
                typeof stored.origin === "string"
                  ? siteIconOrigin(stored.origin)
                  : null;
              if (
                !origin ||
                origin !== stored.origin ||
                typeof stored.data !== "string" ||
                typeof stored.savedAt !== "number"
              )
                return;
              // Re-check what is on disk as strictly as what is fetched.
              const checked = checkSiteIcon(Buffer.from(stored.data, "base64"));
              if (!checked || checked.type !== stored.type) return;
              this.memory.set(origin, stored as StoredIcon);
            } catch {
              // A torn or foreign file is skipped, never shown.
            }
          }),
      );
    })();
    return this.ready;
  }

  /** Data URLs for the cached icons of these addresses' sites. */
  async get(urls: readonly string[]): Promise<Record<string, string>> {
    await this.load();
    const icons: Record<string, string> = {};
    for (const url of urls) {
      const origin = siteIconOrigin(url);
      const stored = origin ? this.memory.get(origin) : null;
      if (origin && stored)
        icons[origin] = `data:${stored.type};base64,${stored.data}`;
    }
    return icons;
  }

  /** Whether this site's icon should be fetched now. */
  async wants(origin: string): Promise<boolean> {
    await this.load();
    const failed = this.failedAt.get(origin);
    if (failed !== undefined && this.now() - failed < SITE_ICON_RETRY_MS)
      return false;
    const stored = this.memory.get(origin);
    return !stored || this.now() - stored.savedAt > SITE_ICON_REFRESH_MS;
  }

  noteFailure(origin: string): void {
    this.failedAt.set(origin, this.now());
  }

  /** Stores checked icon bytes for a site; false when they are refused. */
  async put(url: string, bytes: Uint8Array): Promise<boolean> {
    const origin = siteIconOrigin(url);
    const checked = checkSiteIcon(bytes);
    if (!origin || !checked) {
      if (origin) this.noteFailure(origin);
      return false;
    }
    await this.load();
    const data = Buffer.from(checked.bytes).toString("base64");
    const previous = this.memory.get(origin);
    const stored: StoredIcon = {
      origin,
      type: checked.type,
      data,
      savedAt: this.now(),
    };
    await mkdir(this.directory, { recursive: true });
    // Written whole, then moved into place: a reader never sees half a file.
    const file = this.fileFor(origin);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(stored));
    await rename(temporary, file);
    this.memory.set(origin, stored);
    this.failedAt.delete(origin);
    await this.trim();
    if (previous?.data !== data || previous.type !== stored.type)
      for (const listener of this.listeners) listener();
    return true;
  }

  private async trim(): Promise<void> {
    const entries = [...this.memory.entries()].filter(
      (entry): entry is [string, StoredIcon] => entry[1] !== null,
    );
    if (entries.length <= SITE_ICON_CACHE_MAX_ENTRIES) return;
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [origin] of entries.slice(
      0,
      entries.length - SITE_ICON_CACHE_MAX_ENTRIES,
    )) {
      this.memory.delete(origin);
      await rm(this.fileFor(origin), { force: true });
    }
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * The addresses to try for a page's icon, best first: the icons the page
 * names on its own origin (a `data:` image the page carries counts as its
 * own), then that origin's /favicon.ico. Any other origin is dropped, so no
 * request leaves for a site the person or the search did not open.
 */
export function siteIconCandidates(
  pageUrl: string,
  named: readonly string[],
): string[] {
  const origin = siteIconOrigin(pageUrl);
  if (!origin) return [];
  const out: string[] = [];
  for (const candidate of named) {
    let resolved: URL;
    try {
      resolved = new URL(candidate, pageUrl);
    } catch {
      continue;
    }
    if (resolved.protocol === "data:") {
      if (
        /^data:image\/(png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp)[;,]/i.test(
          candidate,
        )
      )
        out.push(candidate);
      continue;
    }
    if (resolved.origin !== origin) continue;
    // SVG icons are refused when stored; skip asking for them at all.
    if (/\.svgz?$/i.test(resolved.pathname)) continue;
    resolved.hash = "";
    if (!out.includes(resolved.href)) out.push(resolved.href);
  }
  const fallback = `${origin}/favicon.ico`;
  if (!out.includes(fallback)) out.push(fallback);
  return out.slice(0, 4);
}

export type SiteIconFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "error"; credentials: "omit" },
) => Promise<Response>;

/** Reads a response body, stopping as soon as it passes the size cap. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > SITE_ICON_MAX_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SITE_ICON_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function decodeDataUrl(url: string): Uint8Array | null {
  const comma = url.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) return null;
  const body = url.slice(comma + 1);
  if (body.length > Math.ceil((SITE_ICON_MAX_BYTES * 4) / 3) + 4) return null;
  return Buffer.from(body, "base64");
}

/**
 * Fetches and stores the icon of the page at `pageUrl` when the cache wants
 * it, trying the page's own candidates in order. Same origin only: requests
 * carry no cookies and follow no redirect (a redirect could lead elsewhere).
 */
export async function refreshSiteIcon(
  cache: SiteIconCache,
  pageUrl: string,
  named: readonly string[],
  fetchIcon: SiteIconFetch,
): Promise<boolean> {
  const origin = siteIconOrigin(pageUrl);
  if (!origin || !(await cache.wants(origin))) return false;
  for (const candidate of siteIconCandidates(pageUrl, named)) {
    try {
      let bytes: Uint8Array | null;
      if (candidate.startsWith("data:")) bytes = decodeDataUrl(candidate);
      else {
        const response = await fetchIcon(candidate, {
          signal: AbortSignal.timeout(5000),
          redirect: "error",
          credentials: "omit",
        });
        bytes = response.ok ? await readCapped(response) : null;
      }
      if (bytes && (await cache.put(pageUrl, bytes))) return true;
    } catch {
      // The next candidate, or none.
    }
  }
  cache.noteFailure(origin);
  return false;
}

let shared: SiteIconCache | null = null;
/** The app's one icon cache, in `<userData>/site-icons`. */
export async function getSiteIconCache(): Promise<SiteIconCache> {
  if (!shared) {
    const { app } = await import("electron");
    shared = new SiteIconCache(
      path.join(app.getPath("userData"), "site-icons"),
    );
  }
  return shared;
}
