import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
  DesktopBrowserImportInputSchema,
  DesktopBrowserImportSourcesSchema,
} from "@nestor/contracts";
import type { EmbeddedBrowser } from "./embedded-browser";
import {
  importSignInsFromBrowser,
  listBrowserImportSources,
  type ImportEnvironment,
} from "./browser-profile-import";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function chromeProfile(platform: "darwin" | "linux") {
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-source-ids-"));
  temporary.push(directory);
  const suffix =
    platform === "darwin"
      ? "Library/Application Support/Google/Chrome/Default"
      : ".config/google-chrome/Default";
  const nested = path.join(directory, "a".repeat(60));
  const padding = 300 - path.join(nested, suffix).length - 1;
  expect(padding).toBeGreaterThan(0);
  expect(padding).toBeLessThan(255);
  const home = path.join(nested, "b".repeat(padding));
  const profile = path.join(home, suffix);
  expect(profile).toHaveLength(300);
  await mkdir(profile, { recursive: true });
  await writeFile(
    path.join(path.dirname(profile), "Local State"),
    JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Synthetic long-path profile" },
          "Profile 1": { name: "Another synthetic profile" },
        },
      },
    }),
  );
  const db = new DatabaseSync(path.join(profile, "Cookies"));
  try {
    db.exec(
      "CREATE TABLE meta(key TEXT,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,top_frame_site_key TEXT)",
    );
    db.prepare(
      "INSERT INTO cookies VALUES('example.test','fixture_session','synthetic',NULL,'/',0,0,1,1,0,'')",
    ).run();
  } finally {
    db.close();
  }
  const other = path.join(path.dirname(profile), "Profile 1");
  await mkdir(other);
  await writeFile(path.join(other, "Cookies"), "");
  return { env: { platform, home } satisfies ImportEnvironment, profile };
}

test.each(["darwin", "linux"] as const)(
  "%s discovers a 300-character Chrome profile with stable short IDs and unchanged display names",
  async (platform) => {
    const { env, profile } = await chromeProfile(platform);
    const listed = DesktopBrowserImportSourcesSchema.parse(
      await listBrowserImportSources(env),
    );
    expect(listed.sources.map((source) => source.profileLabel)).toEqual([
      "Synthetic long-path profile",
      "Another synthetic profile",
    ]);
    expect(new Set(listed.sources.map((source) => source.id)).size).toBe(2);
    for (const source of listed.sources) {
      expect(source.id.length).toBeLessThanOrEqual(200);
      expect(
        DesktopBrowserImportInputSchema.parse({ sourceId: source.id }).sourceId,
      ).toBe(source.id);
      expect(JSON.stringify(source)).not.toContain(profile);
    }
    expect(
      (await listBrowserImportSources(env)).sources.map((source) => source.id),
    ).toEqual(listed.sources.map((source) => source.id));
  },
);

test("a short source ID still imports from the complete 300-character Chrome path", async () => {
  const { env } = await chromeProfile("linux");
  const source = DesktopBrowserImportSourcesSchema.parse(
    await listBrowserImportSources(env),
  ).sources[0]!;
  const set = vi.fn().mockResolvedValue(undefined);
  const host = {
    takeControl: vi.fn(),
    getSession: () => ({ cookies: { set, flushStore: vi.fn() } }),
  } as unknown as EmbeddedBrowser;
  const result = await importSignInsFromBrowser(
    host,
    { sourceId: source.id },
    env,
  );
  expect(result).toMatchObject({
    status: "imported",
    cookieCount: 1,
    siteCount: 1,
  });
  expect(set).toHaveBeenCalledWith(
    expect.objectContaining({ name: "fixture_session", value: "synthetic" }),
  );
});
