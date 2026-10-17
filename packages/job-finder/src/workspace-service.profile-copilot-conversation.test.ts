import {
  ProfileCopilotPatchGroupSchema,
  type AgentTaskExecutionReceipt,
  type ProfileCopilotMessage,
} from "@nestor/contracts";
import type {
  JobFinderAiClient,
  ReviseCandidateProfileInput,
} from "@nestor/ai-providers";
import { describe, expect, test } from "vitest";

import {
  PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE,
  buildAssistantReplyContent,
  buildPersonDecisionFacts,
  buildRecentConversation,
  placeNewExperiencesByDate,
} from "./internal/workspace-profile-copilot-methods";
import { followPrimaryContacts } from "./internal/profile-merge";
import { createJobFinderProductActionToolRegistry } from "./product-action-tools";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const headlineGroup = ProfileCopilotPatchGroupSchema.parse({
  id: "profile_proposal_1",
  summary: "Change headline to Principal Engineer",
  applyMode: "needs_review",
  operations: [
    {
      operation: "replace_identity_fields",
      value: { headline: "Principal Engineer" },
    },
  ],
  createdAt: "2026-09-23T10:00:00.000Z",
});

function receipt(
  overrides: Partial<AgentTaskExecutionReceipt>,
): AgentTaskExecutionReceipt {
  return {
    taskId: "profile_copilot_test",
    capability: "profile_copilot",
    startedAt: "2026-09-23T10:00:00.000Z",
    completedAt: "2026-09-23T10:00:01.000Z",
    durationMs: 1_000,
    model: "test-model",
    reasoningEffort: null,
    providerCalls: 2,
    repairAttempts: 0,
    fallbackUsed: false,
    stopReason: "completed",
    finalValidationIssues: [],
    toolReceipts: [],
    ...overrides,
  };
}

describe("buildAssistantReplyContent", () => {
  test("keeps what the model wrote, including the question it asks", () => {
    expect(
      buildAssistantReplyContent({
        content:
          "I prepared the new headline. Which years were you at Coimbra Institute of Technology?",
        patchGroups: [headlineGroup],
        proposalsWaitForReview: true,
        modelUnavailable: false,
        writtenByModel: true,
      }),
    ).toBe(
      "I prepared the new headline. Which years were you at Coimbra Institute of Technology? Nothing changed yet.",
    );
  });

  test("describes the proposals itself when the built-in editor wrote the words", () => {
    // The built-in editor says "I applied one safe change" in its own mode,
    // which is false while the change waits for Apply & save.
    const content = buildAssistantReplyContent({
      content: "I applied one safe change: Update headline.",
      patchGroups: [headlineGroup],
      proposalsWaitForReview: true,
      modelUnavailable: true,
      writtenByModel: false,
    });

    expect(content).toBe(
      "The AI did not answer, so Job Finder's built-in editor prepared this. I prepared this change for your review: Change headline to Principal Engineer. Nothing changed yet.",
    );
    expect(content.toLowerCase()).not.toContain("i applied");
  });

  test("describes the proposals when the model never wrote a reply", () => {
    expect(
      buildAssistantReplyContent({
        content:
          "I need to inspect the saved profile before proposing a change.",
        patchGroups: [headlineGroup],
        proposalsWaitForReview: true,
        modelUnavailable: false,
        writtenByModel: true,
      }),
    ).toBe(
      "I prepared this change for your review: Change headline to Principal Engineer. Nothing changed yet.",
    );
  });

  test("answers a question as written when nothing was proposed", () => {
    expect(
      buildAssistantReplyContent({
        content: "Your summary is missing a measurable outcome.",
        patchGroups: [],
        proposalsWaitForReview: true,
        modelUnavailable: false,
        writtenByModel: true,
      }),
    ).toBe("Your summary is missing a measurable outcome.");
  });
});

describe("buildRecentConversation", () => {
  test("hands the model the last turns with what happened to each proposal", () => {
    const messages: ProfileCopilotMessage[] = [
      {
        id: "user_1",
        role: "user",
        content: "What is weak in my profile?",
        context: { surface: "profile", section: "basics" },
        patchGroups: [],
        createdAt: "2026-09-23T10:00:00.000Z",
      },
      {
        id: "assistant_1",
        role: "assistant",
        content: "Your headline is vague.",
        context: { surface: "profile", section: "basics" },
        patchGroups: [
          { ...headlineGroup, id: "assistant_1_patch_1", applyMode: "applied" },
        ],
        createdAt: "2026-09-23T10:00:01.000Z",
      },
    ];

    expect(buildRecentConversation(messages)).toEqual([
      {
        role: "user",
        content: "What is weak in my profile?",
        proposals: [],
      },
      {
        role: "assistant",
        content: "Your headline is vague.",
        proposals: [
          {
            summary: "Change headline to Principal Engineer",
            status: "applied",
          },
        ],
      },
    ]);
  });
});

function createAssistantClient(
  replies: Array<
    (
      input: ReviseCandidateProfileInput,
    ) => Awaited<ReturnType<JobFinderAiClient["reviseCandidateProfile"]>>
  >,
  requests: ReviseCandidateProfileInput[],
): JobFinderAiClient {
  const base = createAiClient();
  let turn = 0;
  return {
    ...base,
    reviseCandidateProfile(input) {
      requests.push(input);
      const reply = replies[Math.min(turn, replies.length - 1)]!;
      turn += 1;
      return Promise.resolve(reply(input));
    },
  };
}

const outageReply = () => ({
  content: "I can answer questions about the saved profile.",
  patchGroups: [],
  executionReceipt: receipt({
    fallbackUsed: true,
    stopReason: "permanent_failure",
    providerCalls: 0,
    model: null,
  }),
});

const modelReply = () => ({
  content: "I prepared a sharper headline for you to apply.",
  patchGroups: [headlineGroup],
  executionReceipt: receipt({}),
});

describe("Profile assistant when the AI does not answer", () => {
  test("keeps the question, records no answer, and says the AI was unavailable", async () => {
    const requests: ReviseCandidateProfileInput[] = [];
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createAssistantClient([outageReply], requests),
    });

    await expect(
      workspaceService.proposeProfileCopilotChange(
        "Change my headline to Principal Engineer.",
        { surface: "profile", section: "basics" },
      ),
    ).rejects.toThrow(PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE);

    const messages = await repository.listProfileCopilotMessages();
    expect(messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "Change my headline to Principal Engineer."],
    ]);
  });

  test("asking again answers the saved question instead of adding a second copy", async () => {
    const requests: ReviseCandidateProfileInput[] = [];
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createAssistantClient([outageReply, modelReply], requests),
    });
    const context = { surface: "profile" as const, section: "basics" as const };

    await expect(
      workspaceService.proposeProfileCopilotChange(
        "Change my headline to Principal Engineer.",
        context,
      ),
    ).rejects.toThrow();
    await workspaceService.proposeProfileCopilotChange(
      "Change my headline to Principal Engineer.",
      context,
    );

    const messages = await repository.listProfileCopilotMessages();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    // What the model wrote reaches the person; the card carries the rest.
    expect(messages[1]?.content).toBe(
      "I prepared a sharper headline for you to apply. Nothing changed yet.",
    );
    expect(
      Date.parse(messages[1]!.createdAt) > Date.parse(messages[0]!.createdAt),
    ).toBe(true);
  });

  test("the product action passes the outage sentence through unchanged", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createAssistantClient([outageReply], []),
    });
    const registry = createJobFinderProductActionToolRegistry(workspaceService);

    const result = await registry.execute("propose_profile_change", {
      request: "Change my headline to Principal Engineer.",
      context: { surface: "profile", section: "basics" },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false ? result.error.message : null).toBe(
      PROFILE_ASSISTANT_UNAVAILABLE_MESSAGE,
    );
  });
});

describe("Profile assistant follow-ups", () => {
  test("'fix it' reaches the model with the turn it refers to", async () => {
    const requests: ReviseCandidateProfileInput[] = [];
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      aiClient: createAssistantClient(
        [
          () => ({
            content: "Your headline is vague and your summary has no outcome.",
            patchGroups: [],
            executionReceipt: receipt({}),
          }),
          modelReply,
        ],
        requests,
      ),
    });
    const context = { surface: "profile" as const, section: "basics" as const };

    await workspaceService.proposeProfileCopilotChange(
      "What is weak in my profile?",
      context,
    );
    await workspaceService.proposeProfileCopilotChange("Fix it.", context);

    expect(requests[1]?.recentConversation).toEqual([
      { role: "user", content: "What is weak in my profile?", proposals: [] },
      {
        role: "assistant",
        content: "Your headline is vague and your summary has no outcome.",
        proposals: [],
      },
    ]);
  });
});

describe("buildPersonDecisionFacts", () => {
  test("remembers what the person applied or turned down, however long ago", () => {
    const message = (
      id: string,
      applyMode: "applied" | "rejected" | "needs_review",
      summary: string,
    ): ProfileCopilotMessage => ({
      id,
      role: "assistant",
      content: "Prepared.",
      context: { surface: "profile", section: "basics" },
      patchGroups: [
        { ...headlineGroup, id: `${id}_patch_1`, applyMode, summary },
      ],
      createdAt: "2026-09-23T10:00:00.000Z",
    });

    expect(
      buildPersonDecisionFacts([
        message("a", "applied", "Remove Terraform from skills"),
        message("b", "rejected", "Add a proof point"),
        message("c", "needs_review", "Change headline"),
      ]),
    ).toEqual([
      "The person applied: Remove Terraform from skills. Do not propose undoing it unless they ask.",
      "The person turned down: Add a proof point. Do not propose it again unless they ask.",
    ]);
  });
});

describe("placeNewExperiencesByDate", () => {
  const role = (id: string, startDate: string | null) => ({ id, startDate });

  test("puts a role the Assistant adds where it belongs in time", () => {
    const before = [
      role("acme", "2021-03"),
      role("northwind", "2017-01"),
      role("bluebird", "2015"),
    ];
    expect(
      placeNewExperiencesByDate(before, [
        ...before,
        role("acme_senior", "2023-01"),
      ]).map((entry) => entry.id),
    ).toEqual(["acme_senior", "acme", "northwind", "bluebird"]);
  });

  test("leaves a list the person ordered some other way alone", () => {
    const before = [role("old", "2015"), role("new", "2021-03")];
    expect(
      placeNewExperiencesByDate(before, [
        ...before,
        role("added", "2018-01"),
      ]).map((entry) => entry.id),
    ).toEqual(["old", "new", "added"]);
  });
});

describe("changing contact details through the Assistant", () => {
  test("moves the application email with the primary one it repeated", async () => {
    const seed = createSeed();
    seed.profile = {
      ...seed.profile,
      email: "alex@example.com",
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: "alex@example.com",
      },
    };
    const emailGroup = ProfileCopilotPatchGroupSchema.parse({
      id: "profile_proposal_email",
      summary: "Update email",
      applyMode: "needs_review",
      operations: [
        {
          operation: "replace_identity_fields",
          value: { email: "alex@new-mail.test" },
        },
      ],
      createdAt: "2026-09-23T10:00:00.000Z",
    });
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: createAssistantClient(
        [
          () => ({
            content: "I prepared the new email.",
            patchGroups: [emailGroup],
            executionReceipt: receipt({}),
          }),
        ],
        [],
      ),
    });

    const proposed = await workspaceService.proposeProfileCopilotChange(
      "My email is now alex@new-mail.test.",
      { surface: "profile", section: "basics" },
    );
    const groupId = proposed.profileCopilotMessages.at(-1)?.patchGroups[0]?.id;
    const applied = await workspaceService.applyProfileCopilotPatchGroup(
      groupId!,
    );

    // Applications read the application email first; it used to keep the
    // old address after the person changed theirs.
    expect(applied.profile.email).toBe("alex@new-mail.test");
    expect(applied.profile.applicationIdentity.preferredEmail).toBe(
      "alex@new-mail.test",
    );
  });

  test("leaves an application email the person chose on purpose", () => {
    const base = createSeed().profile;
    const current = {
      ...base,
      email: "alex@example.com",
      applicationIdentity: {
        ...base.applicationIdentity,
        preferredEmail: "jobs@alex.example",
      },
    };
    expect(
      followPrimaryContacts(current, {
        ...current,
        email: "alex@new-mail.test",
      }).applicationIdentity.preferredEmail,
    ).toBe("jobs@alex.example");
  });
});
