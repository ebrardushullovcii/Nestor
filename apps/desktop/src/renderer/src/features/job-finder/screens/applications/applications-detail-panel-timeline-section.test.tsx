// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ApplicationRecordSchema } from "@nestor/contracts";
import { ApplicationsDetailPanelTimelineSection } from "./applications-detail-panel-timeline-section";
afterEach(cleanup);
it("shows the person's recent send above older unsent activity without mutating history", () => {
  const record = ApplicationRecordSchema.parse({
    id: "application_test",
    jobId: "job_test",
    title: "Engineer",
    company: "Synthetic",
    status: "submitted",
    lastActionLabel: "Sent by you",
    nextActionLabel: null,
    lastUpdatedAt: "2026-10-05T12:00:00Z",
    events: [
      {
        id: "old",
        at: "2026-10-03T12:00:00Z",
        title: "Not sent: choose which applications to send",
        detail: "Choose the jobs.",
        kind: "status_changed",
        emphasis: "neutral",
      },
      {
        id: "new",
        at: "2026-10-05T12:00:00Z",
        title: "You sent this application",
        detail: "The site confirmed receipt.",
        kind: "status_changed",
        emphasis: "neutral",
      },
    ],
  });
  render(<ApplicationsDetailPanelTimelineSection events={record.events} />);
  expect(
    screen
      .getAllByRole("article")
      .map((entry) => entry.querySelector("strong")?.textContent),
  ).toEqual([
    "You sent this application",
    "Not sent: choose which applications to send",
  ]);
  expect(record.events[0]?.id).toBe("old");
});

it("shows an older record's duplicated confirmation once and keeps other history", () => {
  const events = [
    {
      id: "confirmation-one",
      at: "2026-10-05T12:00:00Z",
      title: "Application sent",
      detail: "The site confirmed receipt. Reference: SYN-42.",
      emphasis: "positive" as const,
    },
    {
      id: "confirmation-two",
      at: "2026-10-05T12:00:01Z",
      title: "Submission confirmed",
      detail: "The site confirmed receipt. Reference: SYN-42.",
      emphasis: "positive" as const,
    },
    {
      id: "other",
      at: "2026-10-05T11:00:00Z",
      title: "Prepared",
      detail: "The application was prepared.",
      emphasis: "neutral" as const,
    },
  ];
  render(<ApplicationsDetailPanelTimelineSection events={events} />);
  expect(
    screen.getAllByText("The site confirmed receipt. Reference: SYN-42."),
  ).toHaveLength(1);
  expect(screen.getByText("Activity")).toBeTruthy();
  expect(events).toHaveLength(3);
});

it("shows one confirmation when an older record worded the same send two ways", () => {
  const events = [
    {
      id: "host-wording",
      at: "2026-10-03T21:26:00Z",
      title: "Application submitted",
      detail:
        "127.0.0.1:47950 confirmed that it received this application. Job Finder will not send it again.",
      emphasis: "positive" as const,
    },
    {
      id: "plain-wording",
      at: "2026-10-03T21:26:02Z",
      title: "Application submitted",
      detail: "The employer site confirmed that it received the application.",
      emphasis: "positive" as const,
    },
    {
      id: "repeated",
      at: "2026-10-03T21:20:00Z",
      title: "Job Finder filled the form and is waiting for you.",
      detail: "Job Finder filled the form and is waiting for you.",
      emphasis: "neutral" as const,
    },
  ];
  render(<ApplicationsDetailPanelTimelineSection events={events} />);
  expect(screen.getAllByText("Application submitted")).toHaveLength(1);
  expect(screen.getByText("Activity")).toBeTruthy();
  expect(
    screen.getAllByText("Job Finder filled the form and is waiting for you."),
  ).toHaveLength(1);
});
