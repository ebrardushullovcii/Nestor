import { z } from "zod";

/**
 * A job site's own icon (its favicon), as the app shows it beside the site:
 * on a browser tab, in Profile › Job sites, in the site picker. Icons come
 * only from the site's own origin (the embedded browser's page, or that
 * origin's /favicon.ico), never a third-party lookup, and Electron main keeps
 * them in a local cache so they show offline and after a restart.
 */

/** The largest icon file kept: favicons are small, anything bigger is not one. */
export const SITE_ICON_MAX_BYTES = 64 * 1024;
/** Image types an icon may be stored as. SVG is refused (it can carry script). */
export const SITE_ICON_TYPES = [
  "image/png",
  "image/x-icon",
  "image/gif",
  "image/jpeg",
  "image/webp",
] as const;
export type SiteIconType = (typeof SITE_ICON_TYPES)[number];
/** At most this many sites per request. */
export const SITE_ICONS_MAX_PER_REQUEST = 100;

const SiteIconDataUrlSchema = z
  .string()
  .regex(/^data:image\/(png|x-icon|gif|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/)
  .max(Math.ceil((SITE_ICON_MAX_BYTES * 4) / 3) + 64);

export const SiteIconsInputSchema = z
  .object({
    urls: z.array(z.string().min(1).max(4096)).max(SITE_ICONS_MAX_PER_REQUEST),
  })
  .strict();
export type SiteIconsInput = z.infer<typeof SiteIconsInputSchema>;

/** Cached icons keyed by origin ("https://jobs.example.com"). */
export const SiteIconsSchema = z
  .object({
    icons: z.record(z.string().max(300), SiteIconDataUrlSchema),
  })
  .strict();
export type SiteIcons = z.infer<typeof SiteIconsSchema>;

/**
 * The key a site's icon is cached under: its URL's origin, for http(s)
 * addresses only. Null for anything else (about:blank, a bare label).
 */
export function siteIconOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.origin;
}

export interface SiteIconsBridge {
  /** The cached icons for these addresses' sites; sites with none are left out. */
  get(input: SiteIconsInput): Promise<SiteIcons>;
  /** Fires when an icon was added or replaced in the cache. */
  onChanged(listener: () => void): () => void;
}
