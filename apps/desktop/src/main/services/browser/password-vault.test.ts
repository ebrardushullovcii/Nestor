import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBrowserPasswordRepository } from "@nestor/db";
import { PasswordVault, type PasswordEncryption } from "./password-vault";
import { importPasswordCsv, parsePasswordCsv } from "./password-csv";
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
it("imports Chrome/Edge and Firefox CSV with quotes, embedded newlines, duplicates and invalid URLs", () => {
  const { vault, repository } = setup();
  const result = importPasswordCsv(
    vault,
    '\uFEFFname,url,username,password\r\nSite,https://example.test/login,"a,b","first"\r\nSite,https://example.test/other,"a,b","second"\r\nSite,https://example.test,"a,b","second"\r\nSite,https://second.test,user,"line 1\nline ""2"""\r\nBad,javascript:alert(1),user,ignored\r\nBad,http://example.test,user,ignored',
  );
  expect(result).toMatchObject({ added: 2, updated: 1, skipped: 3 });
  expect("password" in result).toBe(false);
  expect(vault.list().length).toBe(2);
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
