// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunDetailsSchema,
  ApplyRunSchema,
} from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { ApplicationsDetailPanelActivitySections } from "./applications-detail-panel-activity-sections";
afterEach(cleanup);

test("a ready fill-only record displays its answers even without an app send action", () => {
  const at = "2026-10-06T10:00:00.000Z";
  const record = ApplicationRecordSchema.parse({
    id: "application",
    jobId: "job",
    title: "Analyst",
    company: "Synthetic employer",
    status: "drafting",
    lastActionLabel: "Ready to send",
    nextActionLabel: "Review",
    lastUpdatedAt: at,
  });
  const run = ApplyRunSchema.parse({
    id: "run",
    jobIds: ["job"],
    mode: "copilot",
    state: "paused_for_user_review",
    summary: "Ready",
    detail: "Ready",
    createdAt: at,
    updatedAt: at,
  });
  const result = ApplyJobResultSchema.parse({
    id: "result",
    runId: "run",
    jobId: "job",
    applicationRecordId: record.id,
    state: "awaiting_review",
    summary: "Ready",
    detail: "Ready",
    startedAt: at,
    updatedAt: at,
    reviewCard: {
      siteLabel: "Synthetic careers",
      pageUrl: "https://synthetic.example/form",
      preparedAt: at,
      answers: [
        {
          question: "Email",
          answer: "synthetic@example.test",
          source: "your email",
          written: false,
        },
      ],
    },
  });
  const details = ApplyRunDetailsSchema.parse({
    run,
    result,
    results: [result],
    reviewCard: result.reviewCard,
  });
  render(
    <ApplicationsDetailPanelActivitySections
      applyRunDetailsError={null}
      applyRunDetailsStatus="ready"
      applyRunHistory={[]}
      isApplyRequestPending={() => false}
      onExportApplicationPacket={vi.fn()}
      onSaveApplicationAnswer={vi.fn()}
      onClearApplicationAnswer={vi.fn()}
      onResolveApplyConsentRequest={vi.fn()}
      onSelectApplyRun={vi.fn()}
      awaitsYourReview={false}
      onOpenApplicationPage={vi.fn()}
      selectedApplyRunDetails={details}
      selectedApplyRunId="run"
      selectedAttempt={null}
      selectedRecord={record}
      visibleApplyResult={result}
    />,
  );
  expect(screen.getByText("Read this before you send it")).toBeTruthy();
  expect(screen.getByText("synthetic@example.test")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Submit application" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Open this page" })).toBeTruthy();
});
