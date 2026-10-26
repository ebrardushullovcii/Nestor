import type { AssistantRunRef } from "@nestor/contracts";
import type { AssistantHostPorts } from "./ports";
export interface RunStatus {
  jobIds?: string[];
  done: boolean;
  summary: string;
  details: unknown;
  pendingHandoffKey?: string;
  resultKey?: string;
}
/** Follow only the store row this conversation started, never all workspace runs. */
export async function readRunStatus(
  ports: AssistantHostPorts,
  run: AssistantRunRef,
): Promise<RunStatus> {
  if (run.kind === "discovery") {
    const status = await ports.readCommand("search_status", {});
    const search = status.search;
    return {
      done: !search || search.id !== run.id || search.state !== "running",
      summary: search ? `Search ${search.state}.` : "The search ended.",
      details: status,
    };
  }
  if (run.kind === "source_check") {
    const site = await ports.readCommand("get_site", { id: Number(run.id) });
    return {
      done: true,
      summary: site
        ? `Site check: ${site.health}.`
        : "The site is no longer saved.",
      details: site,
    };
  }
  const value = await ports.readCommand("get_application_details", {
    id: Number(run.id),
  });
  if (!value)
    return {
      done: true,
      summary: "The application is no longer recorded.",
      details: null,
    };
  const row = value.application;
  const waiting = row.state === "needs_you";
  const needs = waiting
    ? await ports.readCommand("application_needs", { id: row.id })
    : [];
  const resultKey = `${row.attempt}:${row.state}:${row.updatedAt}`;
  return {
    done: !["queued", "running", "submitting"].includes(row.state),
    summary: `${row.title} at ${row.company}: ${waiting ? "waiting on the person" : row.state.replaceAll("_", " ")}.${needs.length ? " " + needs.map((need) => need.prompt).join("; ") : ""}${row.state === "uncertain" ? " Check the site; do not send again." : ""}`,
    jobIds: [String(row.jobId)],
    details: { ...value, needs, ...(row.state === "uncertain" ? { recovery: "Check the site and ask the person to record the outcome. Do not send again or change sending settings.", sendPermission: "blocked_until_person_checks_outcome" } : {}) },
    resultKey,
    ...(waiting
      ? {
          pendingHandoffKey: `${row.id}:${row.attempt}:${needs.map((need) => need.id).join(",")}`,
        }
      : {}),
  };
}
