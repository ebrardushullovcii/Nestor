import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SITE_ICON_MAX_BYTES, SiteIconsSchema } from "@nestor/contracts";

import {
  SiteIconCache,
  checkSiteIcon,
  refreshSiteIcon,
  siteIconCandidates,
  sniffSiteIconType,
  type SiteIconFetch,
} from "./site-icon-cache";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3,
]);
const ICO = Uint8Array.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);
const SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode(
  "<!doctype html><title>Not found</title>",
);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "site-icons-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function respond(bytes: Uint8Array, init: ResponseInit = {}) {
  return new Response(new Uint8Array(bytes), { status: 200, ...init });
}

describe("site icon checks", () => {
  it("reads the type from the bytes, never from a header or a name", () => {
    expect(sniffSiteIconType(PNG)).toBe("image/png");
    expect(sniffSiteIconType(ICO)).toBe("image/x-icon");
    expect(sniffSiteIconType(new TextEncoder().encode("GIF89a.."))).toBe(
      "image/gif",
    );
    expect(sniffSiteIconType(SVG)).toBeNull();
    expect(sniffSiteIconType(HTML)).toBeNull();
  });

  it("refuses empty, oversized and non-image bytes", () => {
    expect(checkSiteIcon(new Uint8Array())).toBeNull();
    const big = new Uint8Array(SITE_ICON_MAX_BYTES + 1);
    big.set(PNG);
    expect(checkSiteIcon(big)).toBeNull();
    expect(checkSiteIcon(SVG)).toBeNull();
    expect(checkSiteIcon(PNG)?.type).toBe("image/png");
  });
});

describe("siteIconCandidates", () => {
  it("keeps only the page's own origin, then its /favicon.ico", () => {
    expect(
      siteIconCandidates("https://jobs.example.com/careers?x=1", [
        "https://cdn.other.net/icon.png",
        "/static/icon-32.png#frag",
        "https://jobs.example.com/logo.svg",
        "http://jobs.example.com/insecure.png",
        "https://jobs.example.com.evil.io/icon.png",
      ]),
    ).toEqual([
      "https://jobs.example.com/static/icon-32.png",
      "https://jobs.example.com/favicon.ico",
    ]);
  });

  it("asks nothing for pages that are not http(s)", () => {
    expect(siteIconCandidates("about:blank", ["/favicon.ico"])).toEqual([]);
    expect(siteIconCandidates("file:///etc/passwd", [])).toEqual([]);
  });
});

describe("refreshSiteIcon", () => {
  it("fetches only same-origin addresses, without cookies or redirects, and caches the icon", async () => {
    const cache = new SiteIconCache(dir);
    const fetchIcon = vi.fn<SiteIconFetch>(() => Promise.resolve(respond(PNG)));
    expect(
      await refreshSiteIcon(
        cache,
        "https://jobs.example.com/careers",
        ["https://tracker.ads.net/pixel.png", "/icon.png"],
        fetchIcon,
      ),
    ).toBe(true);
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    const [url, init] = fetchIcon.mock.calls[0]!;
    expect(url).toBe("https://jobs.example.com/icon.png");
    expect(init.redirect).toBe("error");
    expect(init.credentials).toBe("omit");

    const icons = await cache.get(["https://jobs.example.com/other/page"]);
    expect(SiteIconsSchema.parse({ icons }).icons).toEqual({
      "https://jobs.example.com": `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    });
  });

  it("falls through refused answers (HTML, SVG, too big, a redirect) to the next candidate", async () => {
    const cache = new SiteIconCache(dir);
    const big = new Uint8Array(SITE_ICON_MAX_BYTES + 10);
    big.set(PNG);
    const answers: Record<string, () => Promise<Response>> = {
      "https://a.test/one.png": () => Promise.resolve(respond(HTML)),
      "https://a.test/two.png": () => Promise.resolve(respond(SVG)),
      "https://a.test/three.png": () =>
        Promise.resolve(
          respond(big, {
            headers: { "content-length": String(big.byteLength) },
          }),
        ),
      // What fetch does with redirect: "error" when the site redirects.
      "https://a.test/favicon.ico": () =>
        Promise.reject(new TypeError("unexpected redirect")),
    };
    const fetchIcon: SiteIconFetch = (url) => answers[url]!();
    expect(
      await refreshSiteIcon(
        cache,
        "https://a.test/",
        ["/one.png", "/two.png", "/three.png"],
        fetchIcon,
      ),
    ).toBe(false);
    expect(await cache.get(["https://a.test/"])).toEqual({});
    // A failed site is not asked again straight away.
    expect(await cache.wants("https://a.test")).toBe(false);
  });

  it("stops reading a body with no length as soon as it passes the cap", async () => {
    const cache = new SiteIconCache(dir);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(pulled === 1 ? PNG : new Uint8Array(16 * 1024));
      },
    });
    const fetchIcon: SiteIconFetch = () =>
      Promise.resolve(new Response(endless, { status: 200 }));
    expect(await refreshSiteIcon(cache, "https://b.test/", [], fetchIcon)).toBe(
      false,
    );
    expect(pulled).toBeLessThan(10);
  });

  it("takes a data: image the page carries without any request", async () => {
    const cache = new SiteIconCache(dir);
    const fetchIcon = vi.fn<SiteIconFetch>();
    const inline = `data:image/x-icon;base64,${Buffer.from(ICO).toString("base64")}`;
    expect(
      await refreshSiteIcon(cache, "https://c.test/x", [inline], fetchIcon),
    ).toBe(true);
    expect(fetchIcon).not.toHaveBeenCalled();
  });

  it("keeps icons across restarts and skips a fresh one", async () => {
    let now = 1_000_000;
    const first = new SiteIconCache(dir, () => now);
    await first.put("https://d.test/jobs", PNG);
    const changed = vi.fn();
    const second = new SiteIconCache(dir, () => now);
    second.onChanged(changed);
    expect(Object.keys(await second.get(["https://d.test/"]))).toEqual([
      "https://d.test",
    ]);
    expect(await second.wants("https://d.test")).toBe(false);
    now += 8 * 24 * 60 * 60 * 1000;
    expect(await second.wants("https://d.test")).toBe(true);
    await second.put("https://d.test/", ICO);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("ignores files on disk that are not a checked icon", async () => {
    await writeFile(
      path.join(dir, `${"a".repeat(32)}.json`),
      JSON.stringify({
        origin: "https://e.test",
        type: "image/png",
        data: Buffer.from(SVG).toString("base64"),
        savedAt: 1,
      }),
    );
    const cache = new SiteIconCache(dir);
    expect(await cache.get(["https://e.test/"])).toEqual({});
    expect((await readdir(dir)).length).toBe(1);
  });
});
