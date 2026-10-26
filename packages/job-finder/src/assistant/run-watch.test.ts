import { ApplicationDetailsSchema } from "@nestor/contracts";
import { expect, it, vi } from "vitest";
import type { AssistantHostPorts } from "./ports";
import { readRunStatus } from "./run-watch";

it("follows an exact application through a human handoff, resumed filling and submission", async () => {
  const application = {
    id: 7,
    jobId: 3,
    title: "Designer",
    company: "Synthetic",
    location: "Remote",
    state: "needs_you",
    attempt: 2,
    mode: "confirm_before_submit",
    queuedAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    submittedAt: null,
    error: null,
  };
  const details = () =>
    ApplicationDetailsSchema.parse({
      application,
      summary: null,
      detail: null,
      reviewCard: null,
      receipt: null,
      resumeFileName: null,
    });
  const readCommand = vi.fn((name: string) =>
    Promise.resolve(name === "application_needs" ? [] : details()),
  );
  const ports = { readCommand } as unknown as AssistantHostPorts;
  const run = { kind: "apply_run" as const, id: "7", jobIds: ["3"] };
  expect(await readRunStatus(ports, run)).toMatchObject({
    done: true,
    pendingHandoffKey: "7:2:",
  });
  application.state = "running";
  expect(await readRunStatus(ports, run)).toMatchObject({ done: false });
  application.state = "submitting";
  expect(await readRunStatus(ports, run)).toMatchObject({ done: false });
  application.state = "submitted";
  expect(await readRunStatus(ports, run)).toMatchObject({ done: true });
  expect(readCommand).toHaveBeenCalledWith("get_application_details", {
    id: 7,
  });
  application.state = "uncertain";
  expect((await readRunStatus(ports, run)).summary).toContain(
    "do not send again",
  );
});

it("reads search progress from the search command", async () => {
  const readCommand = vi.fn(() =>
    Promise.resolve({
      search: { id: "search", state: "running" },
      sources: [],
      progress: null,
      sourceRevision: 0,
    }),
  );
  const ports = { readCommand } as unknown as AssistantHostPorts;
  expect(
    await readRunStatus(ports, { kind: "discovery", id: "search", jobIds: [] }),
  ).toMatchObject({ done: false });
  expect(readCommand).toHaveBeenCalledWith("search_status", {});
});
