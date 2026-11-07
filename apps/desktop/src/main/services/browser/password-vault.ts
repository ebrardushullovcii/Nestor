import { randomUUID, randomInt } from "node:crypto";
import type { BrowserPasswordMetadata } from "@nestor/contracts";
import type { BrowserPasswordRepository } from "@nestor/db";
import { passwordOrigin } from "./password-origin";

export interface PasswordEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface PasswordValue {
  origin: string;
  username: string;
  password: string;
}
export class PasswordVault {
  private readonly generatedAccounts = new Set<string>();
  constructor(
    private readonly repository: BrowserPasswordRepository,
    private readonly encryption: PasswordEncryption,
  ) {}
  available(): boolean {
    try {
      return (
        this.encryption.isEncryptionAvailable() &&
        this.encryption.getSelectedStorageBackend?.() !== "basic_text"
      );
    } catch {
      return false;
    }
  }
  private requireEncryption(): void {
    if (!this.available())
      throw new Error(
        "Secure password storage is unavailable. Enable your operating system keychain, then restart Nestor.",
      );
  }
  list(origin?: string): BrowserPasswordMetadata[] {
    this.requireEncryption();
    return this.repository
      .list()
      .filter((record) => !origin || record.origin === origin);
  }
  read(id: string): PasswordValue | null {
    this.requireEncryption();
    const row = this.repository.get(id);
    if (!row) return null;
    try {
      const value: unknown = JSON.parse(
        this.encryption.decryptString(Buffer.from(row.ciphertext)),
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("origin" in value) ||
        !("username" in value) ||
        !("password" in value) ||
        value.origin !== row.origin ||
        value.username !== row.username ||
        typeof value.password !== "string" ||
        !value.password
      )
        return null;
      return {
        origin: row.origin,
        username: row.username,
        password: value.password,
      };
    } catch {
      throw new Error(
        "This saved login could not be unlocked. Import it again or save a new login.",
      );
    }
  }
  /** Generate once per origin/account so a retry reuses the saved login. */
  generateAccount(origin: string, username: string): BrowserPasswordMetadata {
    const normalized = passwordOrigin(origin);
    if (!normalized || !username.trim())
      throw new Error("The new login needs its site and username.");
    const existing = this.list(normalized).find(
      (row) => row.username === username,
    );
    const accountKey = JSON.stringify([normalized, username]);
    if (
      existing &&
      this.generatedAccounts.has(accountKey) &&
      this.read(existing.id)
    )
      return existing;
    const groups = [
      "ABCDEFGHJKLMNPQRSTUVWXYZ",
      "abcdefghijkmnopqrstuvwxyz",
      "23456789",
      "!@#$%*-_",
    ];
    const alphabet = groups.join("");
    const chars = groups.map((group) => group[randomInt(group.length)]!);
    while (chars.length < 24) chars.push(alphabet[randomInt(alphabet.length)]!);
    for (let index = chars.length - 1; index > 0; index--) {
      const target = randomInt(index + 1);
      [chars[index], chars[target]] = [chars[target]!, chars[index]!];
    }
    this.save({ origin: normalized, username, password: chars.join("") });
    this.generatedAccounts.add(accountKey);
    return this.list(normalized).find((row) => row.username === username)!;
  }
  save(value: PasswordValue): "added" | "updated" | "skipped" {
    this.requireEncryption();
    const origin = passwordOrigin(value.origin);
    this.generatedAccounts.delete(JSON.stringify([origin, value.username]));
    if (
      !origin ||
      value.username.length > 1000 ||
      !value.password ||
      value.password.length > 10000
    )
      throw new Error("This login cannot be saved.");
    const existing = this.list(origin).find(
      (row) => row.username === value.username,
    );
    if (existing) {
      try {
        if (this.read(existing.id)?.password === value.password)
          return "skipped";
      } catch {
        /* Explicitly saving a new login can replace an unreadable entry. */
      }
    }
    const now = new Date().toISOString();
    // Encrypt the binding too, so replacing metadata cannot redirect a credential.
    try {
      const ciphertext = this.encryption.encryptString(
        JSON.stringify({ ...value, origin }),
      );
      this.repository.put({
        id: existing?.id ?? randomUUID(),
        origin,
        username: value.username,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ciphertext,
      });
    } catch {
      throw new Error("This login could not be securely saved.");
    }
    return existing ? "updated" : "added";
  }
  clear(): void {
    for (const record of this.repository.list())
      this.repository.delete(record.id);
  }
  delete(id: string): void {
    this.repository.delete(id);
  }
}
