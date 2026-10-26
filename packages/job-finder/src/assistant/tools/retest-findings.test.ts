import { describe, expect, it } from "vitest";

import { createWorkspaceServiceHarness } from "../../workspace-service.test-support";
import {
  ASSISTANT_SYSTEM_PROMPT,
  buildContextBlock,
  buildProfileDigest,
  plainFieldName,
} from "../prompt";
import { listDocumentsTool } from "./profile-tools";

describe("what the model is told (R1, R4, R5)", () => {
  it("knows attached files are used for applications", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const block = buildContextBlock({
      context: {
        screen: "settings",
        route: "/job-finder/settings",
        sectionLabel: null,
        focus: null,
        list: null,
        editor: null,
        browser: null,
        selectedText: null,
        mentions: [],
        attachments: [
          {
            documentId: "asset_1",
            fileName: "portfolio.pdf",
            mimeType: "application/pdf",
            byteSize: 10,
          },
        ],
        capturedAt: "2026-09-28T00:00:00.000Z",
      } as never,
      resultSets: [],
      snapshot,
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(block).toContain(
      "uploads the matching one to that form's file field",
    );
    expect(listDocumentsTool.description).toContain("no extra step is needed");
  });

  it("does not ask for an extra proposal on every reply by default", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const digest = buildProfileDigest(
      await workspaceService.getWorkspaceSnapshot(),
    );
    expect(digest).not.toContain("add exactly one closely related improvement");
    expect(digest).toContain("Never add one during profile setup");
    expect(digest).toContain("acknowledge the saved result and stop");
  });

  it("names screens as the app shows them", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const block = buildContextBlock({
      context: {
        screen: "review_queue",
        route: "/job-finder/review-queue",
        sectionLabel: null,
        focus: null,
        list: null,
        editor: null,
        browser: null,
        selectedText: null,
        mentions: [],
        attachments: [],
        capturedAt: "2026-09-28T00:00:00.000Z",
      } as never,
      resultSets: [],
      snapshot: await workspaceService.getWorkspaceSnapshot(),
      plan: null,
      grants: [],
      pendingQuestions: [],
      now: "2026-09-28T00:00:00.000Z",
    });
    expect(block).toContain("Screen: Shortlisted (id review_queue)");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Find jobs, Shortlisted");
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("never by routes or ids");
    // The resume screen sits under Shortlisted; "on Resume" named no place.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Shortlisted › Resume");
  });

  it("names fields as the app labels them", () => {
    expect(plainFieldName("jobFamilies")).toBe("Related role areas");
    expect(plainFieldName("preferences.seniorityLevels")).toBe(
      "Seniority levels",
    );
    expect(plainFieldName("noticePeriodDays")).toBe("Notice period days");
  });
});
