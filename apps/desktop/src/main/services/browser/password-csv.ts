import type { BrowserPasswordImportResult } from "@nestor/contracts";
import type { PasswordVault, PasswordValue } from "./password-vault";
import { passwordOrigin } from "./password-origin";

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

export function importPasswordValues(
  vault: PasswordVault,
  values: readonly PasswordValue[],
  skipped = 0,
): BrowserPasswordImportResult {
  const counts = { added: 0, updated: 0, skipped };
  for (const value of values) {
    try {
      counts[vault.save(value)]++;
    } catch {
      counts.skipped++;
    }
  }
  return {
    status: "imported",
    ...counts,
    message: `Added ${counts.added}, updated ${counts.updated}, skipped ${counts.skipped} logins.`,
  };
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
  let skipped = 0;
  for (const row of rows) {
    const origin = passwordOrigin(row[urlIndex] ?? ""),
      username = row[usernameIndex],
      password = row[passwordIndex];
    if (
      !origin ||
      username === undefined ||
      !password ||
      username.length > 1000 ||
      password.length > 10000
    ) {
      skipped++;
      continue;
    }
    values.push({ origin, username, password });
  }
  return importPasswordValues(vault, values, skipped);
}
