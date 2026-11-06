import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const LOGIN = {
  username: "scoreboard@example.test",
  password: "Replica-only-52!test",
};
export const SAFE_STORAGE = "synthetic-scoreboard-safe-storage";
export const EXPECTED = {
  found: 7,
  cookies: 3,
  sites: 3,
  filtered: 2,
  unsupported: 1,
  decryptFailed: 1,
  logins: 2,
};

/** Mac Chromium schema 24; never reads a real browser or Keychain. */
export function makeProfile(
  directory: string,
  origin: string,
  session: string,
) {
  const home = path.join(directory, "synthetic-home");
  const root = path.join(home, "Library/Application Support/Google/Chrome");
  const profile = path.join(root, "Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(root, "Local State"),
    JSON.stringify({
      profile: { info_cache: { Default: { name: "Scoreboard synthetic" } } },
    }),
  );
  const key = pbkdf2Sync(SAFE_STORAGE, "saltysalt", 1003, 16, "sha1");
  const encrypt = (host: string, value: string, bind = true) => {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const plain = bind
      ? Buffer.concat([
          createHash("sha256").update(host).digest(),
          Buffer.from(value),
        ])
      : Buffer.from(value);
    return Buffer.concat([
      Buffer.from("v10"),
      cipher.update(plain),
      cipher.final(),
    ]);
  };
  const db = new DatabaseSync(path.join(profile, "Cookies"));
  try {
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('version','24'); CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,has_expires INTEGER,top_frame_site_key TEXT)",
    );
    const expiry =
      (Math.floor(Date.now() / 1000) + 86400 + 11644473600) * 1000000;
    const insert = db.prepare(
      "INSERT INTO cookies VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const [host, name, value, cookiePath] of [
      ["127.0.0.1", "fixture_session", session, "/workday"],
      ["cookie-a.example.test", "synthetic_a", "fixture-a", "/"],
      ["cookie-b.example.test", "synthetic_b", "fixture-b", "/"],
    ])
      insert.run(
        host,
        name,
        "",
        encrypt(host, value),
        cookiePath,
        expiry,
        0,
        1,
        1,
        1,
        "",
      );
    insert.run(
      "127.0.0.1",
      "expired",
      "",
      encrypt("127.0.0.1", "old"),
      "/",
      1,
      0,
      0,
      1,
      1,
      "",
    );
    insert.run(
      "127.0.0.1",
      "partitioned",
      "",
      encrypt("127.0.0.1", "partitioned"),
      "/",
      expiry,
      0,
      0,
      1,
      1,
      "https://partition.example.test",
    );
    insert.run(
      "127.0.0.1",
      "unsupported",
      "",
      Buffer.from("v99unsupported"),
      "/",
      expiry,
      0,
      0,
      1,
      1,
      "",
    );
    insert.run(
      "127.0.0.1",
      "corrupt",
      "",
      Buffer.from("v10corrupt"),
      "/",
      expiry,
      0,
      0,
      1,
      1,
      "",
    );
  } finally {
    db.close();
  }
  const logins = new DatabaseSync(path.join(profile, "Login Data"));
  try {
    logins.exec(
      "CREATE TABLE logins(origin_url TEXT,action_url TEXT,username_value TEXT,password_value BLOB,blacklisted_by_user INTEGER)",
    );
    for (const site of [origin, "https://login.example.test"])
      logins
        .prepare("INSERT INTO logins VALUES(?,?,?,?,0)")
        .run(site, site, LOGIN.username, encrypt("", LOGIN.password, false));
  } finally {
    logins.close();
    key.fill(0);
  }
  return { home, expected: EXPECTED };
}
