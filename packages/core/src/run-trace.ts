// Main-process only. Deliberately not exported by the renderer-safe core entry.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { setSelfLimitObserver } from "./self-limit";

const scope = new AsyncLocalStorage<Record<string, unknown>>();
let sequence = 0;
export const runTraceEnabled = (): boolean =>
  Boolean(process.env.NESTOR_RUN_TRACE_DIR);

import { traceSafe } from "./trace-redaction.mjs";
export { traceSafe };
import {
  holdVerificationTrace,
  verificationIsPrivate,
} from "./verification-privacy.mjs";
export {
  withVerificationPrivacy,
  holdVerificationTrace,
  markVerificationPrivate,
  verificationIsPrivate,
  rememberVerificationSecret,
  redactVerificationText,
  redactVerificationData,
} from "./verification-privacy.mjs";

/** Observation only: failures and observer return values never affect execution. */
export function traceEvent(
  event: string,
  detail: Record<string, unknown>,
): void {
  const dir = process.env.NESTOR_RUN_TRACE_DIR;
  if (!dir) return;
  try {
    const record: Record<string, unknown> = {
      ...(process.env.NESTOR_VERIFY_NET || process.env.NESTOR_VERIFY_AI
        ? {
            runConfiguration: {
              network: process.env.NESTOR_VERIFY_NET,
              ai: process.env.NESTOR_VERIFY_AI,
            },
          }
        : {}),
      ...scope.getStore(),
      ...detail,
      event,
      at: new Date().toISOString(),
      pid: process.pid,
      seq: ++sequence,
    };
    // While a mailbox is open, a payload may quote a code the model has not
    // typed yet. Keep this moment's copy and write it when the run ends, with
    // every code it used masked.
    if (verificationIsPrivate()) {
      const copy = cloneRecord(record);
      if (
        holdVerificationTrace((codeSeen) =>
          writeTraceRecord(dir, codeSeen ? withoutMailboxImages(copy) : copy),
        )
      )
        return;
    }
    writeTraceRecord(dir, record);
  } catch {
    console.warn(
      "[run-trace] Could not persist an event; evidence is incomplete.",
    );
  }
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(record);
  } catch {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  }
}

function writeTraceRecord(dir: string, record: Record<string, unknown>): void {
  const { mailboxPage, ...rest } = record;
  void mailboxPage;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      path.join(dir, `events-${process.pid}.jsonl`),
      JSON.stringify(traceSafe(rest)) + "\n",
      { mode: 0o600 },
    );
  } catch {
    console.warn(
      "[run-trace] Could not persist an event; evidence is incomplete.",
    );
  }
}

/**
 * Pixels cannot be masked by value. When a run used an emailed code, images
 * from its mailbox window and the mailbox page's own text are omitted.
 */
function withoutMailboxImages(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const visit = (value: unknown): unknown => {
    if (typeof value === "string")
      return /^data:image\//u.test(value)
        ? "[image omitted: code used]"
        : value;
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object" || value instanceof Error)
      return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item)]),
    );
  };
  const cleaned = visit(record) as Record<string, unknown>;
  return record.mailboxPage === true
    ? {
        ...cleaned,
        shot: null,
        visibleText: undefined,
        omitted: "verification privacy",
      }
    : cleaned;
}

export function withTraceScope<T>(
  detail: Record<string, unknown>,
  work: () => T,
): T {
  return runTraceEnabled()
    ? scope.run({ ...scope.getStore(), ...detail }, work)
    : work();
}

export function traceArtifact(
  folder: string,
  bytes: Uint8Array,
  suffix: string,
  options?: { mailboxPage?: boolean },
): string | null {
  const dir = process.env.NESTOR_RUN_TRACE_DIR;
  if (!dir) return null;
  const relative = `${folder}/${Date.now()}-${process.pid}-${randomUUID()}.${suffix}`;
  const write = () => {
    try {
      mkdirSync(path.join(dir, folder), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(dir, relative), bytes, { mode: 0o600 });
      return true;
    } catch {
      console.warn(
        "[run-trace] Could not persist an artifact; evidence is incomplete.",
      );
      return false;
    }
  };
  // A mailbox image is written when the run ends, unless it used a code.
  if (
    options?.mailboxPage &&
    holdVerificationTrace((codeSeen) => {
      if (!codeSeen) write();
    })
  )
    return relative;
  return write() ? relative : null;
}

export type OursKind =
  | "blocked"
  | "rewritten"
  | "capped"
  | "timed_out"
  | "asked_person";
export function traceOurs(by: string, kind: OursKind, reason: string): void {
  traceEvent("ours", { by, kind, reason });
}

setSelfLimitObserver((hit) =>
  traceOurs(
    hit.where,
    hit.kind === "timeout"
      ? "timed_out"
      : hit.kind === "input"
        ? "rewritten"
        : "capped",
    `${hit.limit} (${hit.kind}=${hit.value})`,
  ),
);
