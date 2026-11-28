import { createCipheriv, createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { EmbeddedBrowser } from "./embedded-browser";
import {
  chromiumCookieToDetails,
  decryptChromiumCookieValue,
  deriveChromiumKey,
  firefoxCookieToDetails,
  importSignInsByName,
  importSignInsFromBrowser,
  isGoogleAccountHost,
  listBrowserImportSources,
  listSignInSourcesByName,
  readChromiumCookies,
  readChromiumCookieStore,
  readFirefoxCookies,
  readFirefoxCookieStore,
  chromiumCookieSkipReason,
  readBrowserPasswords,
  snapshotDatabase,
  type ImportEnvironment,
} from "./browser-profile-import";

const temporary: string[] = [];
const dpapi = vi.hoisted(() => vi.fn<(blob: Uint8Array) => Promise<Buffer>>());
vi.mock("@nestor/os-integration", () => ({
  unprotectWindowsCurrentUserData: dpapi,
}));
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function encryptWindows(
  plain: string | Buffer,
  key: Buffer,
  prefix = "v10",
): Buffer {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    Buffer.from(prefix),
    nonce,
    cipher.update(Buffer.from(plain)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

async function windowsProfiles(
  profiles: Record<string, Buffer[]>,
  encryptedKey = Buffer.from("DPAPIsynthetic-wrapped-key"),
) {
  const home = await mkdtemp(path.join(tmpdir(), "nestor-windows-passwords-"));
  temporary.push(home);
  const root = path.join(home, "Microsoft/Edge/User Data");
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "Local State"),
    JSON.stringify({
      os_crypt: {
        encrypted_key: encryptedKey.toString("base64"),
        app_bound_encrypted_key: "ignored-app-bound-key",
      },
    }),
  );
  for (const [profile, values] of Object.entries(profiles)) {
    const dir = path.join(root, profile);
    await mkdir(dir);
    // Cookies can be v20 even while passwords remain v10.
    const cookies = new DatabaseSync(path.join(dir, "Cookies"));
    cookies.exec("CREATE TABLE cookies (encrypted_value BLOB)");
    cookies
      .prepare("INSERT INTO cookies VALUES (?)")
      .run(Buffer.from("v20synthetic-cookie"));
    cookies.close();
    const db = new DatabaseSync(path.join(dir, "Login Data"));
    db.exec(
      "CREATE TABLE logins (origin_url TEXT, action_url TEXT, username_value TEXT, password_value BLOB, blacklisted_by_user INTEGER)",
    );
    const insert = db.prepare("INSERT INTO logins VALUES (?, ?, ?, ?, 0)");
    for (const value of values)
      insert.run(
        "https://example.test/login",
        "https://example.test/session",
        "synthetic",
        value,
      );
    db.close();
  }
  return {
    env: {
      platform: "win32",
      home,
      localAppData: home,
      appData: home,
    } satisfies ImportEnvironment,
    root,
  };
}

describe("Windows profile passwords", () => {
  test("discovers account-only passwords and reads both password stores", async () => {
    const key = Buffer.alloc(32, 4);
    const { env, root } = await windowsProfiles({
      Default: [encryptWindows("synthetic", key)],
    });
    const directory = path.join(root, "Default");
    await copyFile(
      path.join(directory, "Login Data"),
      path.join(directory, "Login Data For Account"),
    );
    await rm(path.join(directory, "Login Data"));
    await rm(path.join(directory, "Cookies"));
    let source = (await listBrowserImportSources(env)).sources[0]!;
    expect(source.passwordImport.supported).toBe(true);
    dpapi.mockImplementation(() => Promise.resolve(Buffer.from(key)));
    expect((await readBrowserPasswords(source.id, env)).values).toHaveLength(1);
    await copyFile(
      path.join(directory, "Login Data For Account"),
      path.join(directory, "Login Data"),
    );
    source = (await listBrowserImportSources(env)).sources[0]!;
    const result = await readBrowserPasswords(source.id, env);
    expect(result.values).toHaveLength(2);
    expect(result.counts).toEqual({
      locked: 0,
      unreadable: 0,
      invalid: 0,
      unsupportedEncryption: 0,
      androidApp: 0,
      unsupportedOrigin: 0,
      couldNotSave: 0,
    });
  });

  test("reports protected and empty rows across both stores without requesting a key", async () => {
    const { env, root } = await windowsProfiles({
      Default: [
        encryptWindows("synthetic", Buffer.alloc(32, 4), "v20"),
        Buffer.alloc(0),
      ],
    });
    await copyFile(
      path.join(root, "Default/Login Data"),
      path.join(root, "Default/Login Data For Account"),
    );
    const source = (await listBrowserImportSources(env)).sources[0]!;
    expect(source.passwordImport).toMatchObject({ supported: false });
    expect(source.passwordImport.note).toMatch(/Found 4.*2.*app-bound.*CSV/);
    const result = await readBrowserPasswords(source.id, env);
    expect(result).toMatchObject({
      values: [],
      unsupported: true,
      counts: {
        locked: 2,
        invalid: 2,
        unreadable: 0,
        unsupportedEncryption: 0,
      },
    });
    expect(dpapi).not.toHaveBeenCalled();
  });

  test("discovers capability per profile, independently of cookies, without unwrapping a key", async () => {
    const key = Buffer.alloc(32, 4);
    const { env, root } = await windowsProfiles({
      Default: [encryptWindows("synthetic", key, "v20")],
      "Profile 1": [encryptWindows("synthetic", key)],
      "Profile 2": [
        encryptWindows("synthetic", key),
        encryptWindows("synthetic", key, "v20"),
      ],
      "Profile 3": [],
    });
    // Password-only profiles must be discoverable too.
    await rm(path.join(root, "Profile 1/Cookies"));
    const { sources } = await listBrowserImportSources(env);
    expect(
      sources.map((source) => [
        source.profileLabel,
        source.supported,
        source.passwordImport.supported,
      ]),
    ).toEqual([
      ["Default", false, false],
      ["Profile 1", false, true],
      ["Profile 2", false, true],
      ["Profile 3", false, false],
    ]);
    expect(sources[0]?.passwordImport.note).toMatch(/locked.*CSV/);
    expect(sources[3]?.passwordImport.note).toMatch(/No saved passwords/);
    expect(dpapi).not.toHaveBeenCalled();
    expect(JSON.stringify(sources)).not.toContain(env.home);
    const locked = await readBrowserPasswords(sources[0]!.id, env);
    expect(locked.unsupported).toBe(true);
    expect(locked.counts.locked).toBe(1);
    expect(dpapi).not.toHaveBeenCalled();
  });

  test("unwraps only DPAPI, imports authenticated v10, skips v20/corrupt rows and clears the key", async () => {
    const key = Buffer.alloc(32, 4);
    const corrupt = encryptWindows("synthetic-corrupt", key);
    corrupt[corrupt.length - 1]! ^= 1;
    const { env } = await windowsProfiles({
      Default: [
        encryptWindows("synthetic-only", key),
        // Valid GCM with a v20 prefix still must never be imported.
        encryptWindows("synthetic-app-bound", key, "v20"),
        corrupt,
        Buffer.from("v10short"),
        encryptWindows("synthetic-v11", key, "v11"),
      ],
    });
    const unwrapped = Buffer.from(key);
    dpapi.mockImplementation((blob) => {
      expect(
        Buffer.from(blob).equals(Buffer.from("synthetic-wrapped-key")),
      ).toBe(true);
      return Promise.resolve(unwrapped);
    });
    const source = (await listBrowserImportSources(env)).sources[0]!;
    const result = await readBrowserPasswords(source.id, env);
    expect(result).toEqual({
      values: [
        {
          origin: "https://example.test",
          username: "synthetic",
          password: "synthetic-only",
          upgradedToHttps: false,
        },
      ],
      unsupported: false,
      counts: {
        locked: 1,
        unreadable: 2,
        invalid: 0,
        unsupportedEncryption: 1,
        androidApp: 0,
        unsupportedOrigin: 0,
        couldNotSave: 0,
      },
    });
    expect(dpapi).toHaveBeenCalledOnce();
    expect(unwrapped.every((byte) => byte === 0)).toBe(true);
  });

  test("counts passwords as unreadable when the DPAPI key is unavailable", async () => {
    const key = Buffer.alloc(32, 4);
    const { env, root } = await windowsProfiles(
      { Default: [encryptWindows("synthetic", key)] },
      Buffer.from("APPBsynthetic-key"),
    );
    let source = (await listBrowserImportSources(env)).sources[0]!;
    expect(source.passwordImport.supported).toBe(false);
    expect(await readBrowserPasswords(source.id, env)).toMatchObject({
      values: [],
      unsupported: true,
      counts: { unreadable: 1 },
    });
    expect(dpapi).not.toHaveBeenCalled();
    await writeFile(
      path.join(root, "Local State"),
      JSON.stringify({
        os_crypt: {
          encrypted_key: Buffer.from("DPAPIsynthetic-wrapped-key").toString(
            "base64",
          ),
        },
      }),
    );
    source = (await listBrowserImportSources(env)).sources[0]!;
    dpapi.mockRejectedValueOnce(new Error("Windows key access failed."));
    expect(await readBrowserPasswords(source.id, env)).toMatchObject({
      values: [],
      counts: { unreadable: 1 },
    });
    const wrongKey = Buffer.alloc(16, 3);
    dpapi.mockResolvedValueOnce(wrongKey);
    expect(await readBrowserPasswords(source.id, env)).toMatchObject({
      values: [],
      counts: { unreadable: 1 },
    });
    expect(wrongKey.every((byte) => byte === 0)).toBe(true);
  });
});

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plain),
    cipher.final(),
  ]);
}

async function windowsCookieProfile() {
  const key = Buffer.alloc(32, 4);
  const { env, root } = await windowsProfiles({ Default: [] });
  const file = path.join(root, "Default/Cookies");
  await rm(file);
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24')",
  );
  db.exec(
    "CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, has_expires INTEGER, top_frame_site_key TEXT)",
  );
  const digest = createHash("sha256").update(".example.test").digest();
  const encrypted = encryptWindows(
    Buffer.concat([digest, Buffer.from("synthetic-cookie")]),
    key,
  );
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1]! ^= 1;
  const insert = db.prepare(
    "INSERT INTO cookies VALUES (?, ?, ?, ?, '/', ?, 1, 1, 0, ?, ?)",
  );
  insert.run(".example.test", "legacy", "", encrypted, 0, 0, "");
  insert.run(
    "plain.test",
    "plain",
    "synthetic-plain",
    Buffer.alloc(0),
    0,
    0,
    "",
  );
  insert.run(
    ".example.test",
    "protected",
    "",
    encryptWindows("synthetic", key, "v20"),
    0,
    0,
    "",
  );
  insert.run(".example.test", "corrupt", "", corrupt, 0, 0, "");
  insert.run(
    ".example.test",
    "unknown",
    "",
    Buffer.from("v99synthetic"),
    0,
    0,
    "",
  );
  insert.run(".example.test", "expired", "", encrypted, 1, 1, "");
  insert.run(
    ".example.test",
    "partitioned",
    "",
    encrypted,
    0,
    0,
    "https://other.test",
  );
  insert.run("bad host", "invalid", "", encrypted, 0, 0, "");
  db.close();
  return { env, root, file, key };
}

describe("Windows cookie import accounting", () => {
  test("authenticates GCM, validates the host digest and counts every skip without leaking cookie material", async () => {
    const { file, key } = await windowsCookieProfile();
    const { cookies, diagnostics } = readChromiumCookieStore(
      file,
      key,
      "win32",
    );
    expect(cookies).toHaveLength(2);
    expect(cookies[0]?.value).toBe("synthetic-cookie");
    expect(diagnostics).toEqual({
      found: 8,
      appBound: 1,
      unsupportedEncryption: 1,
      decryptFailed: 1,
      expired: 1,
      partitioned: 1,
      invalid: 1,
      googleCookies: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/synthetic|example|legacy/);
    const encrypted = encryptWindows(
      Buffer.concat([
        createHash("sha256").update("other.test").digest(),
        Buffer.from("synthetic"),
      ]),
      key,
    );
    expect(
      decryptChromiumCookieValue(encrypted, key, ".example.test", 24, "win32"),
    ).toBeNull();
    expect(
      readChromiumCookieStore(file, Buffer.alloc(32, 9), "win32").diagnostics
        .decryptFailed,
    ).toBe(2);
  });

  test("imports readable Windows cookies, reports partial coverage and browser rejections, and clears the key", async () => {
    const traceDir = await mkdtemp(path.join(tmpdir(), "nestor-import-trace-"));
    temporary.push(traceDir);
    vi.stubEnv("NESTOR_RUN_TRACE_DIR", traceDir);
    const { env, key } = await windowsCookieProfile();
    const unwrapped = Buffer.from(key);
    dpapi.mockResolvedValueOnce(unwrapped);
    const set = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("synthetic-private-value"));
    const takeControl = vi.fn();
    const host = {
      takeControl,
      getSession: () => ({ cookies: { set, flushStore: vi.fn() } }),
    } as unknown as EmbeddedBrowser;
    const source = (await listBrowserImportSources(env)).sources[0]!;
    expect(source.supported).toBe(true);
    expect(dpapi).not.toHaveBeenCalled();
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
    expect(result.message).toBe(
      "Copied 1 cookie for 1 site from Microsoft Edge. Sites that use them may keep you signed in. If one asks you to sign in, sign in here.",
    );
    // Every cookie found is accounted for once, each reason on its own.
    expect(result.counts).toEqual({
      found: 8,
      expired: 1,
      partitioned: 1,
      invalid: 1,
      lockedToBrowser: 1,
      unsupportedEncryption: 1,
      couldNotDecrypt: 1,
      googleCookies: 0,
      refused: 1,
    });
    // Running searches and applications are left alone during an import.
    expect(takeControl).not.toHaveBeenCalled();
    // No Google cookies in this profile, so no Google sentence.
    expect(result.googleSignInNotice).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/synthetic|example|legacy/);
    expect(unwrapped.every((byte) => byte === 0)).toBe(true);
    const traceFile = (await readdir(traceDir)).find((file) =>
      file.endsWith(".jsonl"),
    )!;
    const trace = await readFile(path.join(traceDir, traceFile), "utf8");
    expect(trace).toContain('"event":"browser_import_inventory"');
    expect(trace).toContain('"found":8');
    expect(trace).toContain('"importedCookieCount":1');
    expect(trace).not.toContain("synthetic-private-value");
    for (const call of set.mock.calls) {
      const cookie = call[0] as { value?: string };
      if (cookie.value) expect(trace).not.toContain(cookie.value);
    }
  });

  test("leaves Google cookies behind while importing another site", async () => {
    const { env, file } = await windowsCookieProfile();
    const db = new DatabaseSync(file);
    db.exec(
      "DELETE FROM cookies WHERE name NOT IN ('plain', 'legacy'); UPDATE cookies SET host_key='.google.com' WHERE name='legacy'",
    );
    db.close();
    const set = vi.fn();
    const host = {
      getSession: () => ({ cookies: { set, flushStore: vi.fn() } }),
    } as unknown as EmbeddedBrowser;
    const source = (await listBrowserImportSources(env)).sources[0]!;
    const result = await importSignInsFromBrowser(
      host,
      { sourceId: source.id },
      env,
    );
    expect(result).toMatchObject({
      status: "imported",
      cookieCount: 1,
      siteCount: 1,
      counts: { found: 2, googleCookies: 1, refused: 0 },
    });
    expect(set).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "plain" }),
    );
    expect(dpapi).not.toHaveBeenCalled();
    expect(result.googleSignInNotice).toBe(
      "Google cookies stay in Microsoft Edge to protect any Google sign-in you’ve already made in Nestor. If Google asks you to sign in again, do it in Nestor’s browser.",
    );
    expect(result.message).toMatch(/^Copied 1 cookie for 1 site/);

    const googleOnly = new DatabaseSync(file);
    googleOnly.exec("DELETE FROM cookies WHERE name = 'plain'");
    googleOnly.close();
    set.mockClear();
    const skipped = await importSignInsFromBrowser(
      host,
      { sourceId: source.id },
      env,
    );
    expect(skipped).toMatchObject({
      status: "unsupported",
      cookieCount: 0,
      googleSignInNotice: result.googleSignInNotice,
      counts: { found: 1, googleCookies: 1, refused: 0 },
    });
    expect(set).not.toHaveBeenCalled();
  });

  test("does not attempt app-bound decryption and explains a protected-only profile", async () => {
    const { env, file } = await windowsCookieProfile();
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM cookies WHERE name <> 'protected'");
    db.close();
    const source = (await listBrowserImportSources(env)).sources[0]!;
    expect(source.supported).toBe(false);
    expect(source.note).toMatch(/Found 1.*1.*app-bound.*Sign in here directly/);
    const takeControl = vi.fn();
    const host = { takeControl } as unknown as EmbeddedBrowser;
    expect(
      await importSignInsFromBrowser(host, { sourceId: source.id }, env),
    ).toMatchObject({ status: "unsupported", cookieCount: 0, siteCount: 0 });
    expect(dpapi).not.toHaveBeenCalled();
    expect(takeControl).not.toHaveBeenCalled();
  });

  test("imports plaintext without an encryption key and reports failed legacy decryption", async () => {
    const { env, root } = await windowsCookieProfile();
    await rm(path.join(root, "Local State"));
    const set = vi.fn();
    const host = {
      takeControl: vi.fn(),
      getSession: () => ({ cookies: { set, flushStore: vi.fn() } }),
    } as unknown as EmbeddedBrowser;
    const source = (await listBrowserImportSources(env)).sources[0]!;
    const result = await importSignInsFromBrowser(
      host,
      { sourceId: source.id },
      env,
    );
    expect(result).toMatchObject({ status: "imported", cookieCount: 1 });
    expect(result.counts?.couldNotDecrypt).toBe(2);
    expect(set).toHaveBeenCalledOnce();
    expect(dpapi).not.toHaveBeenCalled();
  });

  test("does not claim a successful import when saving the cookie store fails", async () => {
    const { env, file } = await windowsCookieProfile();
    const db = new DatabaseSync(file);
    db.exec("DELETE FROM cookies WHERE name <> 'plain'");
    db.close();
    const host = {
      takeControl: vi.fn(),
      getSession: () => ({
        cookies: {
          set: vi.fn(),
          flushStore: vi
            .fn()
            .mockRejectedValue(new Error("synthetic-private-value")),
        },
      }),
    } as unknown as EmbeddedBrowser;
    const source = (await listBrowserImportSources(env)).sources[0]!;
    const result = await importSignInsFromBrowser(
      host,
      { sourceId: source.id },
      env,
    );
    expect(result).toMatchObject({
      status: "failed",
      cookieCount: 1,
      siteCount: 1,
    });
    expect(result.message).toContain("could not be saved");
    expect(result.message).not.toContain("synthetic");
    expect(dpapi).not.toHaveBeenCalled();
  });
});

test("snapshots include uncheckpointed WAL rows and leave the live store unchanged", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-wal-test-"));
  temporary.push(directory);
  const file = path.join(directory, "source");
  const db = new DatabaseSync(file);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE records (value INTEGER); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO records VALUES (1)",
  );
  try {
    const snapshot = await snapshotDatabase(file);
    try {
      const copy = new DatabaseSync(snapshot.path, { readOnly: true });
      try {
        expect(
          copy.prepare("SELECT COUNT(*) AS total FROM records").get()?.total,
        ).toBe(1);
      } finally {
        copy.close();
      }
      expect(
        db.prepare("SELECT COUNT(*) AS total FROM records").get()?.total,
      ).toBe(1);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    db.close();
  }
});

test("an unreadable WAL fails the snapshot instead of silently importing an incomplete database", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nestor-wal-test-"));
  temporary.push(directory);
  const file = path.join(directory, "source");
  await writeFile(file, "synthetic");
  await mkdir(`${file}-wal`);
  await expect(snapshotDatabase(file)).rejects.toThrow();
});

test("reports skipped password origins and upgrades remote HTTP to the same site over HTTPS", async () => {
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
    "https://cross-origin.test/sign-in",
    "https://foreign.test",
    "synthetic",
    encrypt(Buffer.from("synthetic-only"), key),
  );
  for (const origin of [
    "http://localhost:8080/sign-in",
    "http://remote.test:8443/sign-in",
    "android://fixture@com.example.fixture/",
    "ftp://example.test",
    "malformed-origin",
  ]) {
    insert.run(
      origin,
      origin,
      "synthetic",
      encrypt(Buffer.from("synthetic-only"), key),
    );
  }
  insert.run(
    "https://long.test",
    "https://long.test",
    "synthetic",
    encrypt(Buffer.from("x".repeat(10001)), key),
  );
  db.close();
  const env: ImportEnvironment = { platform: "linux", home };
  const source = (await listBrowserImportSources(env)).sources[0]!;
  const result = await readBrowserPasswords(source.id, env);
  expect(result.values.map((value) => value.origin)).toEqual([
    "https://example.test",
    "https://cross-origin.test",
    "http://localhost:8080",
    "https://remote.test:8443",
  ]);
  expect(result.values.map((value) => value.upgradedToHttps)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(
    result.values.every((value) => value.password === "synthetic-only"),
  ).toBe(true);
  expect(result.counts).toMatchObject({
    androidApp: 1,
    unsupportedOrigin: 1,
    invalid: 1,
    couldNotSave: 1,
  });
  expect(result.unsupported).toBe(false);
  const fallback = await readBrowserPasswords(source.id, {
    platform: "win32",
    home,
    localAppData: home,
    appData: home,
  });
  expect(fallback).toMatchObject({ values: [], unsupported: true });
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
      decryptChromiumCookieValue(encrypted, key, ".example.test", 24, "darwin"),
    ).toBe("session-token");
    expect(
      decryptChromiumCookieValue(encrypted, key, ".other.test", 24, "darwin"),
    ).toBeNull();
    expect(
      decryptChromiumCookieValue(
        encrypt(Buffer.from("legacy"), key),
        key,
        ".example.test",
        20,
        "darwin",
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
    expect(
      chromiumCookieToDetails(
        { ...row, host_key: "9999999999999" },
        "abc",
        now,
      ),
    ).toBeNull();
    // Each skipped row names its own reason.
    expect(chromiumCookieSkipReason(row, now)).toBeNull();
    expect(chromiumCookieSkipReason({ ...row, expires_utc: 1 }, now)).toBe(
      "expired",
    );
    expect(
      chromiumCookieSkipReason(
        { ...row, top_frame_site_key: "https://embedder.test" },
        now,
      ),
    ).toBe("partitioned");
    expect(
      chromiumCookieSkipReason({ ...row, host_key: "bad host" }, now),
    ).toBe("invalid");
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
    expect(windows.sources[0]?.note).toContain("sign in directly in Nestor");
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
    const cookies = readChromiumCookies(file, key, "darwin");
    expect(
      cookies.map((cookie) => [cookie.name, cookie.value, cookie.sameSite]),
    ).toEqual([
      ["sid", "secret-token", "no_restriction"],
      ["theme", "dark", "unspecified"],
    ]);
    expect(
      readChromiumCookies(file, deriveChromiumKey("wrong", 1003), "darwin"),
    ).toEqual([expect.objectContaining({ name: "theme" })]);
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
    const insert = db.prepare(
      "INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes) VALUES (?, 'x', ?, '/', ?, 1, 0, 1, ?)",
    );
    const later = Math.floor(Date.now() / 1000) + 60;
    insert.run("old", ".example.test", 1, "");
    insert.run(
      "embedded",
      ".example.test",
      later,
      "^partitionKey=(https,other.test)",
    );
    insert.run("bad", "bad host", later, "");
    insert.run("google", ".google.com", later, "");
    db.close();
    expect(readFirefoxCookies(file)).toEqual([
      expect.objectContaining({ name: "sid", value: "abc", sameSite: "lax" }),
    ]);
    // Firefox imports count what they leave out the same way Chromium does.
    expect(readFirefoxCookieStore(file).diagnostics).toEqual({
      found: 5,
      appBound: 0,
      unsupportedEncryption: 0,
      decryptFailed: 0,
      expired: 1,
      partitioned: 1,
      invalid: 1,
      googleCookies: 1,
    });
  });

  test("reports an empty device honestly", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nestor-home-"));
    temporary.push(home);
    const listed = await listBrowserImportSources({ platform: "darwin", home });
    expect(listed.sources).toEqual([]);
    expect(listed.note).toMatch(/No browser profiles/);
  });

  test("the Assistant chooses a profile by name and never sees its id", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nestor-home-"));
    temporary.push(home);
    const localAppData = path.join(home, "AppData/Local");
    const chrome = path.join(localAppData, "Google/Chrome/User Data");
    for (const profile of ["Default", "Profile 1"]) {
      await mkdir(path.join(chrome, profile), { recursive: true });
      await writeFile(path.join(chrome, profile, "Cookies"), "");
    }
    const env: ImportEnvironment = {
      platform: "win32",
      home,
      localAppData,
      appData: path.join(home, "AppData/Roaming"),
    };
    const listed = await listSignInSourcesByName(env);
    expect(listed.sources).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(/"id"|AppData/);

    // Windows protects every Chrome profile alike: no need to ask which.
    const takeControl = vi.fn();
    const host = { takeControl } as unknown as EmbeddedBrowser;
    const chromeResult = await importSignInsByName(
      host,
      { browser: "chrome" },
      env,
    );
    expect(chromeResult.status).toBe("unsupported");
    expect(chromeResult.message).toContain("sign in directly in Nestor");
    expect(
      (
        await importSignInsByName(
          host,
          { browser: "chrome", profileLabel: "profile 1" },
          env,
        )
      ).status,
    ).toBe("unsupported");
    const missing = await importSignInsByName(
      host,
      { browser: "firefox" },
      env,
    );
    expect(missing).toMatchObject({ status: "failed", cookieCount: 0 });
    expect(missing.message).toMatch(/No Firefox profile/);
    expect(takeControl).not.toHaveBeenCalled();
  });

  test("asks which profile when a readable browser has several", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "nestor-home-"));
    temporary.push(home);
    const chrome = path.join(home, "Library/Application Support/Google/Chrome");
    for (const profile of ["Default", "Profile 1"]) {
      await mkdir(path.join(chrome, profile), { recursive: true });
      await writeFile(path.join(chrome, profile, "Cookies"), "");
    }
    const takeControl = vi.fn();
    const host = { takeControl } as unknown as EmbeddedBrowser;
    const result = await importSignInsByName(
      host,
      { browser: "chrome" },
      { platform: "darwin", home },
    );
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/more than one profile.*Say which one/);
    expect(takeControl).not.toHaveBeenCalled();
  });
});

test("Google account hosts are named so the import can say their sign-ins stay behind", () => {
  for (const host of [
    ".google.com",
    "accounts.google.com",
    "mail.google.com",
    "www.google.de",
    "google.co.uk",
    ".youtube.com",
  ])
    expect(isGoogleAccountHost(host)).toBe(true);
  for (const host of ["notgoogle.com", "google.example.test", "github.com"])
    expect(isGoogleAccountHost(host)).toBe(false);
});
