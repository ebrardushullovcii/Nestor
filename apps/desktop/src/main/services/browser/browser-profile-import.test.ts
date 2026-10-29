import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  chromiumCookieToDetails,
  decryptChromiumCookieValue,
  deriveChromiumKey,
  firefoxCookieToDetails,
  listBrowserImportSources,
  readChromiumCookies,
  readFirefoxCookies,
  readBrowserPasswords,
  type ImportEnvironment,
} from "./browser-profile-import";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
}

test("imports only explicitly chosen synthetic Chromium passwords and reports Windows CSV fallback", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "nestor-password-import-"));
  temporary.push(home);
  const directory = path.join(home, ".config/google-chrome/Default");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "Cookies"), "synthetic-placeholder");
  const db = new DatabaseSync(path.join(directory, "Login Data"));
  db.exec(
    "CREATE TABLE logins (origin_url TEXT, action_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
  );
  const key = deriveChromiumKey("peanuts", 1);
  const insert = db.prepare("INSERT INTO logins VALUES (?, ?, ?, ?, 0)");
  insert.run(
    "https://example.test/login",
    "https://example.test/session",
    "synthetic",
    encrypt(Buffer.from("synthetic-only"), key),
  );
  insert.run(
    "http://remote.test",
    "http://remote.test",
    "synthetic",
    encrypt(Buffer.from("synthetic-only"), key),
  );
  insert.run(
    "https://example.test",
    "https://foreign.test",
    "synthetic",
    encrypt(Buffer.from("synthetic-only"), key),
  );
  db.close();
  const env: ImportEnvironment = { platform: "linux", home };
  const source = (await listBrowserImportSources(env)).sources[0]!;
  const result = await readBrowserPasswords(source.id, env);
  expect(result.values.length).toBe(1);
  expect(result.values[0]?.password === "synthetic-only").toBe(true);
  expect(result.skipped).toBe(2);
  expect(result.unsupported).toBe(false);
  const fallback = await readBrowserPasswords(source.id, {
    platform: "win32",
    home,
    localAppData: home,
    appData: home,
  });
  expect(fallback).toEqual({ values: [], skipped: 0, unsupported: true });
});

describe("browser profile import", () => {
  test("decrypts a v10 cookie and strips the schema-24 host digest", () => {
    const key = deriveChromiumKey("synthetic-password", 1003);
    const digest = createHash("sha256").update(".example.test").digest();
    const encrypted = encrypt(
      Buffer.concat([digest, Buffer.from("session-token")]),
      key,
    );
    expect(
      decryptChromiumCookieValue(encrypted, key, ".example.test", 24),
    ).toBe("session-token");
    expect(
      decryptChromiumCookieValue(encrypted, key, ".other.test", 24),
    ).toBeNull();
    expect(
      decryptChromiumCookieValue(
        encrypt(Buffer.from("legacy"), key),
        key,
        ".example.test",
        20,
      ),
    ).toBe("legacy");
    expect(
      decryptChromiumCookieValue(Buffer.from("v99abc"), key, "a", 24),
    ).toBeNull();
  });

  test("maps Chromium rows to Electron cookies and skips expired or partitioned ones", () => {
    const now = 1_700_000_000;
    const future = (now + 3600 + 11_644_473_600) * 1_000_000;
    const row = {
      host_key: ".example.test",
      name: "sid",
      value: "",
      encrypted_value: null,
      path: "/",
      expires_utc: future,
      is_secure: 1,
      is_httponly: 1,
      samesite: 1,
      has_expires: 1,
      top_frame_site_key: "",
    };
    expect(chromiumCookieToDetails(row, "abc", now)).toEqual({
      url: "https://example.test/",
      name: "sid",
      value: "abc",
      path: "/",
      domain: ".example.test",
      secure: true,
      httpOnly: true,
      expirationDate: now + 3600,
      sameSite: "lax",
    });
    expect(
      chromiumCookieToDetails({ ...row, expires_utc: 1 }, "abc", now),
    ).toBeNull();
    expect(
      chromiumCookieToDetails(
        { ...row, top_frame_site_key: "https://embedder.test" },
        "abc",
        now,
      ),
    ).toBeNull();
    expect(
      chromiumCookieToDetails({ ...row, host_key: "bad host" }, "abc", now),
    ).toBeNull();
    const hostOnly = chromiumCookieToDetails(
      { ...row, host_key: "app.example.test", has_expires: 0 },
      "abc",
      now,
    );
    expect(hostOnly).not.toHaveProperty("domain");
    expect(hostOnly).not.toHaveProperty("expirationDate");
  });

  test("maps Firefox rows and skips partitioned cookies", () => {
    const now = 1_700_000_000;
    expect(
      firefoxCookieToDetails(
        {
          host: ".example.test",
          name: "sid",
          value: "abc",
          path: "/",
          expiry: now + 60,
          isSecure: 1,
          isHttpOnly: 0,
          sameSite: 2,
          originAttributes: "",
        },
        now,
      ),
    ).toMatchObject({ url: "https://example.test/", sameSite: "strict" });
    expect(
      firefoxCookieToDetails(
        {
          host: ".example.test",
          name: "sid",
          value: "abc",
          path: "/",
          expiry: now + 60,
          isSecure: 1,
          isHttpOnly: 0,
          sameSite: 0,
          originAttributes: "^partitionKey=(https,other.test)",
        },
        now,
      ),
    ).toBeNull();
  });

  test("lists profiles from installed browsers without exposing paths", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nestor-home-"));
    temporary.push(home);
    const chrome = path.join(home, "Library/Application Support/Google/Chrome");
    await mkdir(path.join(chrome, "Default/Network"), { recursive: true });
    await mkdir(path.join(chrome, "Profile 1"), { recursive: true });
    await mkdir(path.join(chrome, "Guest Profile"), { recursive: true });
    await writeFile(path.join(chrome, "Default/Network/Cookies"), "");
    await writeFile(path.join(chrome, "Profile 1/Cookies"), "");
    await writeFile(path.join(chrome, "Guest Profile/Cookies"), "");
    await writeFile(
      path.join(chrome, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: { Default: { name: "Person 1" }, "Profile 1": {} },
        },
      }),
    );
    const firefox = path.join(home, "Library/Application Support/Firefox");
    await mkdir(path.join(firefox, "Profiles/abc.default-release"), {
      recursive: true,
    });
    await writeFile(
      path.join(firefox, "Profiles/abc.default-release/cookies.sqlite"),
      "",
    );
    await writeFile(
      path.join(firefox, "profiles.ini"),
      "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n",
    );
    const env: ImportEnvironment = { platform: "darwin", home };
    const listed = await listBrowserImportSources(env);
    expect(listed.note).toBeNull();
    expect(
      listed.sources.map((source) => [
        source.browser,
        source.profileLabel,
        source.supported,
      ]),
    ).toEqual([
      ["chrome", "Person 1", true],
      ["chrome", "Profile 1", true],
      ["firefox", "default-release", true],
    ]);
    for (const source of listed.sources) {
      expect(JSON.stringify(source)).not.toContain(home);
    }
    const localAppData = path.join(home, "AppData/Local");
    await mkdir(path.join(localAppData, "Google/Chrome/User Data/Default"), {
      recursive: true,
    });
    await writeFile(
      path.join(localAppData, "Google/Chrome/User Data/Default/Cookies"),
      "",
    );
    const windows = await listBrowserImportSources({
      platform: "win32",
      home,
      localAppData,
      appData: path.join(home, "AppData/Roaming"),
    });
    expect(
      windows.sources.map((source) => [source.browser, source.supported]),
    ).toEqual([["chrome", false]]);
    expect(windows.sources[0]?.note).toMatch(/Sign in here directly/);
  });

  test("reads and decrypts a Chromium cookie store end to end", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nestor-chromium-"));
    temporary.push(dir);
    const file = path.join(dir, "Cookies");
    const key = deriveChromiumKey("synthetic-password", 1003);
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE meta (key TEXT, value TEXT)");
    db.exec(
      "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, top_frame_site_key TEXT)",
    );
    db.prepare("INSERT INTO meta VALUES ('version', '24')").run();
    const digest = createHash("sha256").update(".example.test").digest();
    const future = (Date.now() / 1000 + 3600 + 11_644_473_600) * 1_000_000;
    db.prepare(
      "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      ".example.test",
      "sid",
      "",
      encrypt(Buffer.concat([digest, Buffer.from("secret-token")]), key),
      "/",
      Math.round(future),
      1,
      1,
      0,
      1,
      "",
    );
    db.prepare(
      "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("plain.test", "theme", "dark", null, "/", 0, 0, 0, -1, 0, "");
    db.close();
    const cookies = readChromiumCookies(file, key);
    expect(
      cookies.map((cookie) => [cookie.name, cookie.value, cookie.sameSite]),
    ).toEqual([
      ["sid", "secret-token", "no_restriction"],
      ["theme", "dark", "unspecified"],
    ]);
    expect(readChromiumCookies(file, deriveChromiumKey("wrong", 1003))).toEqual(
      [expect.objectContaining({ name: "theme" })],
    );
  });

  test("reads a Firefox cookie store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "nestor-firefox-"));
    temporary.push(dir);
    const file = path.join(dir, "cookies.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)",
    );
    db.prepare(
      "INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES ('sid', 'abc', '.example.test', '/', ?, 1, 1, 1)",
    ).run(Math.floor(Date.now() / 1000) + 60);
    db.close();
    expect(readFirefoxCookies(file)).toEqual([
      expect.objectContaining({ name: "sid", value: "abc", sameSite: "lax" }),
    ]);
  });

  test("reports an empty device honestly", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nestor-home-"));
    temporary.push(home);
    const listed = await listBrowserImportSources({ platform: "darwin", home });
    expect(listed.sources).toEqual([]);
    expect(listed.note).toMatch(/No browser profiles/);
  });
});
