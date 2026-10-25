// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { cleanup, render, } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, } from "vitest";

import {
  resetRecentChangesForTest,
} from "../../lib/recent-changes";
import { RecentChangesSection } from "./recent-changes-section";

const workspace = {
  discoveryJobs: [],
  reviewQueue: [{ jobId: "job_a", resumeReview: { status: "draft" } }],
  applicationRecords: [],
} as unknown as JobFinderRendererWorkspaceSnapshot;

beforeEach(() => resetRecentChangesForTest());
afterEach(() => cleanup());

describe("RecentChangesSection", () => {

  test("shows nothing before the first move", () => {
    const { container } = render(
      <RecentChangesSection
        onUndo={() => Promise.resolve(true)}
        workspace={workspace}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
