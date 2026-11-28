import type {
  BrowserPasswordImportCounts,
  BrowserPasswordImportResult,
} from "@nestor/contracts";
import type { PasswordVault, PasswordValue } from "./password-vault";
import { passwordImportOrigin } from "./password-origin";

/** RFC 4180 fields, including escaped quotes and embedded CR/LF. Errors never quote input. */
export function parsePasswordCsv(text: string): string[][] {
  if (text.length > 10 * 1024 * 1024)
    throw new Error("Password CSV is too large.");
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  text = text.replace(/^\uFEFF/u, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else if (ch === '"' && !field && !closed) quoted = true;
    else {
      if (closed || ch === '"')
        throw new Error("Password CSV has invalid quoting.");
      field += ch;
    }
  }
  if (quoted) throw new Error("Password CSV has an unfinished field.");
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function savePasswordValues(
  vault: PasswordVault,
  values: readonly PasswordValue[],
) {
  const counts = { added: 0, updated: 0, alreadySaved: 0, couldNotSave: 0 };
  for (const value of values) {
    try {
      const outcome = vault.save(value);
      counts[outcome === "skipped" ? "alreadySaved" : outcome]++;
    } catch {
      counts.couldNotSave++;
    }
  }
  return counts;
}

export function countSkippedPasswordImports(
  counts: BrowserPasswordImportCounts,
) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return total - counts.added - counts.updated;
}

export function importPasswordCsv(
  vault: PasswordVault,
  text: string,
): BrowserPasswordImportResult {
  if (!vault.available())
    throw new Error("Secure password storage is unavailable.");
  const [header, ...rows] = parsePasswordCsv(text);
  const names = header?.map((cell) => cell.toLowerCase().trim()) ?? [];
  const urlIndex = names.findIndex(
    (name) => name === "url" || name === "origin" || name === "hostname",
  );
  const usernameIndex = names.indexOf("username"),
    passwordIndex = names.indexOf("password");
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0)
    throw new Error(
      "Choose a Chrome, Edge or Firefox password CSV with URL, username and password columns.",
    );
  const values: PasswordValue[] = [];
  const rejected = {
    locked: 0,
    unsupportedEncryption: 0,
    unreadable: 0,
    insecureHttp: 0,
    androidApp: 0,
    unsupportedOrigin: 0,
    invalid: 0,
    couldNotSave: 0,
  };
  for (const row of rows) {
    const username = row[usernameIndex],
      password = row[passwordIndex];
    if (username === undefined || !password) {
      rejected.invalid++;
      continue;
    }
    const origin = passwordImportOrigin(row[urlIndex] ?? "");
    if ("skipped" in origin) {
      rejected[origin.skipped]++;
      continue;
    }
    if (username.length > 1000 || password.length > 10000) {
      rejected.couldNotSave++;
      continue;
    }
    values.push({ origin: origin.origin, username, password });
  }
  const saved = savePasswordValues(vault, values);
  const counts = {
    ...rejected,
    ...saved,
    couldNotSave: rejected.couldNotSave + saved.couldNotSave,
  };
  const { added, updated, alreadySaved } = counts;
  const imported = added + updated + alreadySaved > 0;
  return {
    status: imported ? "imported" : "failed",
    added,
    updated,
    skipped: countSkippedPasswordImports(counts),
    counts,
    message: imported
      ? "Passwords do not bring over signed-in sessions. Sign in to the site in Nestor when needed."
      : "No logins were imported from this CSV.",
  };
}
