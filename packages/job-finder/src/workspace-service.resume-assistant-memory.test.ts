import { describe, expect, test } from "vitest";
import type { ReviseResumeDraftInput } from "@nestor/ai-providers";
import {
  createAiClient,
  fakeResumeClaimCheck,
} from "./workspace-service.test-runtimes";
import { createWorkspaceServiceHarness } from "./workspace-service.test-support";

const UNGROUNDED_SUMMARY =
  "Senior Software Engineer with 10+ years building secure, scalable healthcare SaaS platforms with C#, .NET, ASP.NET Core, REST APIs, MongoDB, SQL Server, and Azure/AWS. Delivered microservices and EHR-adjacent integrations for scheduling and billing.";

describe("Resume Studio Assistant memory and approval check", () => {
  test("each request carries the recent turns with proposal status and a gate the agent can run", async () => {
    const baseAiClient = createAiClient();
    const seen: ReviseResumeDraftInput[] = [];
    const { workspaceService } = createWorkspaceServiceHarness({
      aiClient: {
        ...baseAiClient,
        checkResumeClaims: fakeResumeClaimCheck({
          [UNGROUNDED_SUMMARY]: "unsupported",
        }),
        reviseResumeDraft(input) {
          seen.push(input);
          const section = input.draft.sections.find((entry) =>
            entry.text?.trim(),
          )!;
          return Promise.resolve({
            content: "One summary change.",
            patches:
              seen.length === 1
                ? [
                    {
                      id: "resume_patch_1",
                      draftId: input.draft.id,
                      operation: "replace_section_text" as const,
                      targetSectionId: section.id,
                      targetEntryId: null,
                      anchorEntryId: null,
                      targetBulletId: null,
                      anchorBulletId: null,
                      position: null,
                      newText: `${section.text} Focused on accessible interfaces.`,
                      newIncluded: null,
                      newLocked: null,
                      newBullets: null,
                      appliedAt: new Date().toISOString(),
                      origin: "assistant" as const,
                      conflictReason: null,
                    },
                  ]
                : [],
          });
        },
      },
    });
    await workspaceService.generateResume("job_ready");

    await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "What would you change to fit this job better?",
    );
    await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "the second one",
    );

    expect(seen[0]?.recentConversation).toEqual([]);
    const second = seen[1]!;
    expect(second.request).toBe("the second one");
    expect(second.recentConversation?.map((turn) => turn.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(second.recentConversation?.[0]?.content).toBe(
      "What would you change to fit this job better?",
    );
    expect(second.recentConversation?.[1]?.proposal?.status).toBe(
      "waiting_for_review",
    );
    expect(
      second.recentConversation?.[1]?.proposal?.changes[0]?.newText,
    ).toContain("Focused on accessible interfaces.");

    // The gate the agent runs is the service's own: wording the evidence does
    // not back comes back flagged as unsupported before the agent finishes.
    const section = second.draft.sections.find((entry) => entry.text?.trim())!;
    const check = await second.checkProposal!([
      {
        id: "resume_patch_9",
        draftId: second.draft.id,
        operation: "replace_section_text",
        targetSectionId: section.id,
        targetEntryId: null,
        anchorEntryId: null,
        targetBulletId: null,
        anchorBulletId: null,
        position: null,
        newText: UNGROUNDED_SUMMARY,
        newIncluded: null,
        newLocked: null,
        newBullets: null,
        appliedAt: new Date().toISOString(),
        origin: "assistant",
        conflictReason: null,
      },
    ]);
    expect(check.applyError).toBeNull();
    expect(check.findings.length).toBeGreaterThan(0);
    expect(check.findings[0]?.patchId).toBe("resume_patch_9");
    expect(
      check.findings.some((finding) => finding.kind === "unsupported"),
    ).toBe(true);

    const clean = await second.checkProposal!([]);
    expect(clean).toEqual({ applyError: null, findings: [], droppedOnSave: [] });

    // The agent can measure the pages its changes would produce.
    const measured = await second.measurePages!([]);
    expect(measured.targetPageCount).toBe(second.draft.targetPageCount);
    expect(measured.pageCount === null || measured.pageCount >= 1).toBe(true);
  });
});
