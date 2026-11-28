import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBrowserPasswordRepository } from "@nestor/db";
import { PasswordVault, type PasswordEncryption } from "./password-vault";
import {
  importPasswordCsv,
  savePasswordValues,
  parsePasswordCsv,
} from "./password-csv";
import { passwordOrigin, passwordOriginsMatch } from "./password-origin";

const dirs: string[] = [];
afterEach(() => {
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
// A synthetic authenticated cipher exercises the vault contract without any OS keychain.
export function syntheticEncryption(): PasswordEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keychain",
    encryptString: (value) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const cipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString();
    },
  };
}
function setup(encryption = syntheticEncryption()) {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-vault-test-"));
  dirs.push(dir);
  const file = path.join(dir, "passwords.sqlite");
  const repository = createBrowserPasswordRepository(file);
  return { file, repository, vault: new PasswordVault(repository, encryption) };
}
it("persists only encrypted values, reopens, updates and deletes one origin/account", () => {
  const encryption = syntheticEncryption();
  const { vault, repository, file } = setup(encryption);
  const value = {
    origin: "https://example.test/login",
    username: "synthetic-user",
    password: randomBytes(30).toString("hex"),
  };
  expect(vault.save(value)).toBe("added");
  const metadata = vault.list()[0]!;
  expect("password" in metadata).toBe(false);
  expect(vault.save(value)).toBe("skipped");
  expect(vault.save({ ...value, password: `${value.password}-new` })).toBe(
    "updated",
  );
  expect(vault.list().length).toBe(1);
  expect(readFileSync(file).includes(Buffer.from(value.password))).toBe(false);
  repository.close();
  const reopened = createBrowserPasswordRepository(file);
  const next = new PasswordVault(reopened, encryption);
  expect(next.read(metadata.id)?.password === `${value.password}-new`).toBe(
    true,
  );
  // The encrypted binding prevents ciphertext moved to a different origin from being used.
  const row = reopened.get(metadata.id)!;
  reopened.put({
    ...row,
    id: "tampered",
    origin: "https://other.test",
    username: "other",
  });
  expect(next.read("tampered")).toBeNull();
  next.delete(metadata.id);
  expect(next.list("https://example.test").length).toBe(0);
  reopened.close();
});
it.each(["unavailable", "basic_text"])(
  "refuses %s encryption without plaintext fallback",
  (backend) => {
    const { vault, repository } = setup({
      ...syntheticEncryption(),
      isEncryptionAvailable: () => backend !== "unavailable",
      getSelectedStorageBackend: () => backend,
    });
    expect(vault.available()).toBe(false);
    expect(() =>
      vault.save({
        origin: "https://example.test",
        username: "test",
        password: "synthetic",
      }),
    ).toThrow("unavailable");
    expect(repository.list().length).toBe(0);
    repository.close();
  },
);
it("imports Chrome/Edge and Firefox CSV and separates rejected rows in the receipt", () => {
  const { vault, repository } = setup();
  const result = importPasswordCsv(
    vault,
    [
      "\uFEFFname,url,username,password",
      'Site,https://example.test/login,"a,b","first"',
      'Site,https://example.test/other,"a,b","second"',
      'Site,https://example.test,"a,b","second"',
      'Site,https://second.test,user,"line 1\nline ""2"""',
      "Local,http://127.0.0.1:8080,,synthetic",
      "Unsupported,javascript:alert(1),user,ignored",
      "HTTP,http://example.test,user,ignored",
      "Android,android://fixture@com.example.fixture/,user,ignored",
      "Malformed,not-a-url,user,ignored",
      "Empty,https://empty.test,user,",
      `Long,https://long.test,user,${"x".repeat(10001)}`,
    ].join("\r\n"),
  );
  expect(result).toMatchObject({
    added: 3,
    updated: 1,
    skipped: 7,
    counts: {
      alreadySaved: 1,
      insecureHttp: 1,
      androidApp: 1,
      unsupportedOrigin: 1,
      invalid: 2,
      couldNotSave: 1,
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/example\.test|ignored|synthetic/);
  expect(vault.list().length).toBe(3);
  expect(
    importPasswordCsv(
      vault,
      "url,username,password,httpRealm,formActionOrigin\nhttps://firefox.test,fox,synthetic,,https://firefox.test",
    ).added,
  ).toBe(1);
  expect(() =>
    parsePasswordCsv('url,username,password\n"unterminated'),
  ).toThrow("unfinished");
  repository.close();
});
it("rejects malformed CSV without including rejected content in errors", () => {
  const secret = randomBytes(20).toString("hex");
  try {
    parsePasswordCsv(`url,username,password\n"${secret}`);
    throw new Error("expected rejection");
  } catch (error) {
    expect(String(error).includes(secret)).toBe(false);
  }
});
it("does not report an empty or wholly rejected password import as successful", () => {
  const { vault, repository } = setup();
  try {
    expect(importPasswordCsv(vault, "url,username,password")).toMatchObject({
      status: "failed",
      added: 0,
    });
    expect(
      savePasswordValues(vault, [
        {
          origin: "http://remote.test",
          username: "synthetic",
          password: "synthetic",
        },
      ]),
    ).toMatchObject({ couldNotSave: 1 });
    const value = {
      origin: "https://example.test",
      username: "synthetic",
      password: "synthetic",
    };
    expect(savePasswordValues(vault, [value])).toMatchObject({ added: 1 });
    expect(savePasswordValues(vault, [value])).toMatchObject({
      added: 0,
      alreadySaved: 1,
    });
    expect(vault.list()).toHaveLength(1);
  } finally {
    repository.close();
  }
});
it("uses exact secure origins including ports; loopback HTTP is allowed for replicas", () => {
  expect(passwordOrigin("https://example.test/path")).toBe(
    "https://example.test",
  );
  for (const url of [
    "http://example.test",
    "javascript:alert(1)",
    "file:///tmp",
    "https://user:pass@example.test",
    "garbage",
  ])
    expect(passwordOrigin(url)).toBeNull();
  expect(passwordOrigin("http://127.0.0.1:47950/path")).toBe(
    "http://127.0.0.1:47950",
  );
  const saved = "https://example.test";
  for (const changed of [
    "https://sub.example.test",
    "https://example.test.evil.test",
    "http://example.test",
    "https://example.test:444",
  ]) {
    expect(passwordOriginsMatch(saved, changed, saved, saved)).toBe(false);
    expect(passwordOriginsMatch(saved, saved, changed, saved)).toBe(false);
    expect(passwordOriginsMatch(changed, saved, saved, saved)).toBe(false);
  }
});

it("clears saved accounts for workspace/browser reset even when the keychain is unavailable", () => {
  const encryption = syntheticEncryption();
  const { vault, repository } = setup(encryption);
  vault.save({
    origin: "https://example.test",
    username: "synthetic-user",
    password: "synthetic-reset-password",
  });
  encryption.isEncryptionAvailable = () => false;
  vault.clear();
  expect(repository.list()).toHaveLength(0);
  repository.close();
});
