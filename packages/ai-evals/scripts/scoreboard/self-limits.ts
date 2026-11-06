import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SelfLimitHit } from "@nestor/contracts";
import type { Result, Run } from "./types.ts";

const marker = "[self_limit_hit] ";

/** Reads only logs owned by this run, including the main/worker process logs. */
export function readSelfLimitHits(output: string): {
  hits: SelfLimitHit[];
  unreadable: string[];
  logsRead: number;
} {
  const hits: SelfLimitHit[] = [];
  const unreadable: string[] = [];
  let logsRead = 0;
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:log|jsonl)$/u.test(entry.name)) {
        logsRead++;
        for (const [index, line] of readFileSync(file, "utf8")
          .split("\n")
          .entries()) {
          const at = line.indexOf(marker);
          const raw = at >= 0 ? line.slice(at + marker.length) : line.trim();
          if (at < 0 && !raw.startsWith('{"event":"self_limit_hit"')) continue;
          try {
            const hit: unknown = JSON.parse(raw);
            if (
              !hit ||
              typeof hit !== "object" ||
              !("event" in hit) ||
              hit.event !== "self_limit_hit" ||
              !("limit" in hit) ||
              typeof hit.limit !== "string" ||
              !("kind" in hit) ||
              typeof hit.kind !== "string" ||
              !("where" in hit) ||
              typeof hit.where !== "string" ||
              !("value" in hit) ||
              (!["number", "string", "boolean"].includes(typeof hit.value) &&
                hit.value !== null)
            )
              throw Error("Invalid self_limit_hit record");
            hits.push(hit as SelfLimitHit);
          } catch {
            unreadable.push(`${path.relative(output, file)}:${index + 1}`);
          }
        }
      }
    }
  };
  visit(output);
  return { hits, unreadable, logsRead };
}

export function auditSelfLimits(run: Run): Result {
  const { hits, unreadable, logsRead } = readSelfLimitHits(run.output);
  const limits = [
    ...new Set(
      hits.map(
        (hit) => `${hit.limit} (${hit.kind}=${hit.value}) at ${hit.where}`,
      ),
    ),
  ];
  const row: Result = {
    id: "self-limits",
    name: "Our own limits",
    status:
      hits.length || unreadable.length ? "fail" : logsRead ? "pass" : "not run",
    seconds: 0,
    questions: [],
    metrics: {
      summary: `${hits.length} limit events; ${limits.join("; ") || "none"}${unreadable.length ? `; unreadable records: ${unreadable.join(", ")}` : ""}`,
      hits,
      unreadable,
      logsRead,
    },
    ...(hits.length || unreadable.length
      ? {
          failure: {
            step: "aggregate self-limit audit",
            happened: `${limits.join("; ")}${unreadable.length ? ` Invalid event records: ${unreadable.join(", ")}` : ""}`,
            likelyPackage: "the code locations listed in the limit events",
          },
        }
      : {}),
  };
  const index = run.results.findIndex((result) => result.id === row.id);
  if (index < 0) run.results.push(row);
  else run.results[index] = row;
  return row;
}
