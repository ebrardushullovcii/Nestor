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

/** Observation only: failures and observer return values never affect execution. */
export function traceEvent(
  event: string,
  detail: Record<string, unknown>,
): void {
  const dir = process.env.NESTOR_RUN_TRACE_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      path.join(dir, `events-${process.pid}.jsonl`),
      JSON.stringify(
        traceSafe({
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
        }),
      ) + "\n",
      { mode: 0o600 },
    );
  } catch {
    console.warn(
      "[run-trace] Could not persist an event; evidence is incomplete.",
    );
  }
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
): string | null {
  const dir = process.env.NESTOR_RUN_TRACE_DIR;
  if (!dir) return null;
  try {
    const relative = `${folder}/${Date.now()}-${process.pid}-${randomUUID()}.${suffix}`;
    mkdirSync(path.join(dir, folder), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(dir, relative), bytes, { mode: 0o600 });
    return relative;
  } catch {
    console.warn(
      "[run-trace] Could not persist an artifact; evidence is incomplete.",
    );
    return null;
  }
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
