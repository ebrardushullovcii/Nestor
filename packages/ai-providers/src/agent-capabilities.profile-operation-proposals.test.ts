import { describe, expect, test } from "vitest";
import type { ProfileCopilotPatchOperation } from "@nestor/contracts";

import {
  findBulletsOnTwoCards,
  runProfileCopilotAgentTask,
} from "./agent-capabilities";
import type { AgentCapableJobFinderAiClient } from "./shared";
import { createDeterministicJobFinderAiClient } from "./deterministic";
import { createPreferences, createProfile } from "./test-fixtures";

interface ScriptedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ScriptedReply {
  content?: string;
  toolCalls?: ScriptedToolCall[];
}

function createScriptedToolClient(
  replies: ScriptedReply[],
): AgentCapableJobFinderAiClient {
  const deterministic = createDeterministicJobFinderAiClient();
  let index = 0;
  return {
    ...deterministic,
    chatWithTools() {
      return Promise.resolve(replies[index++] ?? { toolCalls: [] });
    },
  };
}

function call(name: string, id: string, args: unknown): ScriptedToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function proposeCall(
  id: string,
  operations: unknown[],
  extraInput: Record<string, unknown> = {},
): ScriptedToolCall {
  return call("propose_profile_operations", id, {
    summary: "Proposed profile update for review.",
    operations,
    ...extraInput,
  });
}

const finishCall = (id: string) => call("finish_task", id, {});

type CopilotRequest = Parameters<
  typeof runProfileCopilotAgentTask
>[0]["request"];

function createCopilotRequest(requestText: string): CopilotRequest {
  return {
    profile: createProfile(),
    searchPreferences: createPreferences(),
    context: { surface: "general" },
    relevantReviewItems: [],
    request: requestText,
  };
}

interface ProfileOperationCase {
  /** Raw arguments exactly as a model would send them in the operations array. */
  input: Record<string, unknown>;
  /** The fully normalized contract operation expected back from the runtime. */
  expected: Record<string, unknown>;
}

// Compile-time exhaustive map over ProfileCopilotPatchOperation discriminants.
// Adding or removing an operation kind in @nestor/contracts must update
// this table or this file fails to typecheck.
const operationCases: Record<
  ProfileCopilotPatchOperation["operation"],
  ProfileOperationCase
> = {
  replace_identity_fields: {
    input: {
      operation: "replace_identity_fields",
      value: { headline: "Product-minded staff frontend engineer" },
    },
    expected: {
      operation: "replace_identity_fields",
      value: { headline: "Product-minded staff frontend engineer" },
    },
  },
  replace_work_eligibility_fields: {
    input: {
      operation: "replace_work_eligibility_fields",
      value: { remoteEligible: true },
    },
    expected: {
      operation: "replace_work_eligibility_fields",
      value: { remoteEligible: true },
    },
  },
  replace_professional_summary_fields: {
    input: {
      operation: "replace_professional_summary_fields",
      value: { shortValueProposition: "Ships accessible product UI." },
    },
    expected: {
      operation: "replace_professional_summary_fields",
      value: { shortValueProposition: "Ships accessible product UI." },
    },
  },
  replace_narrative_fields: {
    input: {
      operation: "replace_narrative_fields",
      value: {
        professionalStory: "Moved from support into frontend engineering.",
      },
    },
    expected: {
      operation: "replace_narrative_fields",
      value: {
        professionalStory: "Moved from support into frontend engineering.",
      },
    },
  },
  replace_answer_bank_fields: {
    input: {
      operation: "replace_answer_bank_fields",
      value: { availability: "Two weeks after an offer." },
    },
    expected: {
      operation: "replace_answer_bank_fields",
      value: { availability: "Two weeks after an offer." },
    },
  },
  replace_application_identity_fields: {
    input: {
      operation: "replace_application_identity_fields",
      value: { preferredEmail: "alex.vanguard@example.com" },
    },
    expected: {
      operation: "replace_application_identity_fields",
      value: { preferredEmail: "alex.vanguard@example.com" },
    },
  },
  replace_skill_group_fields: {
    input: {
      operation: "replace_skill_group_fields",
      value: { coreSkills: ["React", "TypeScript"] },
    },
    expected: {
      operation: "replace_skill_group_fields",
      value: { coreSkills: ["React", "TypeScript"] },
    },
  },
  replace_profile_list_fields: {
    input: {
      operation: "replace_profile_list_fields",
      value: { targetRoles: ["Staff Frontend Engineer"] },
    },
    expected: {
      operation: "replace_profile_list_fields",
      value: { targetRoles: ["Staff Frontend Engineer"] },
    },
  },
  remove_profile_list_entries: {
    input: {
      operation: "remove_profile_list_entries",
      field: "skills",
      values: ["React"],
    },
    expected: {
      operation: "remove_profile_list_entries",
      field: "skills",
      values: ["React"],
    },
  },
  replace_search_preferences_fields: {
    input: {
      operation: "replace_search_preferences_fields",
      value: { workModes: ["hybrid"] },
    },
    expected: {
      operation: "replace_search_preferences_fields",
      value: { workModes: ["hybrid"] },
    },
  },
  set_resume_approach: {
    input: {
      operation: "set_resume_approach",
      value: "original_resume",
    },
    expected: {
      operation: "set_resume_approach",
      value: "original_resume",
    },
  },
  replace_compensation_preferences_fields: {
    input: {
      operation: "replace_compensation_preferences_fields",
      value: { minimum: 150000, interval: "year" },
    },
    expected: {
      operation: "replace_compensation_preferences_fields",
      value: { minimum: 150000, interval: "year" },
    },
  },
  upsert_experience_record: {
    input: {
      operation: "upsert_experience_record",
      record: { companyName: "Acme Interactive", title: "Frontend Engineer" },
    },
    expected: {
      operation: "upsert_experience_record",
      record: {
        id: null,
        companyName: "Acme Interactive",
        title: "Frontend Engineer",
      },
    },
  },
  remove_experience_record: {
    input: {
      operation: "remove_experience_record",
      recordId: "experience_1",
    },
    expected: {
      operation: "remove_experience_record",
      recordId: "experience_1",
    },
  },
  upsert_education_record: {
    input: {
      operation: "upsert_education_record",
      record: { schoolName: "Tech State University" },
    },
    expected: {
      operation: "upsert_education_record",
      record: {
        id: null,
        schoolName: "Tech State University",
      },
    },
  },
  remove_education_record: {
    input: {
      operation: "remove_education_record",
      recordId: "education_1",
    },
    expected: {
      operation: "remove_education_record",
      recordId: "education_1",
    },
  },
  reorder_education_records: {
    input: {
      operation: "reorder_education_records",
      orderedRecordIds: ["education_2", "education_1"],
    },
    expected: {
      operation: "reorder_education_records",
      orderedRecordIds: ["education_2", "education_1"],
    },
  },
  upsert_certification_record: {
    input: {
      operation: "upsert_certification_record",
      record: { name: "AWS Solutions Architect" },
    },
    expected: {
      operation: "upsert_certification_record",
      record: {
        id: null,
        name: "AWS Solutions Architect",
      },
    },
  },
  remove_certification_record: {
    input: {
      operation: "remove_certification_record",
      recordId: "certification_1",
    },
    expected: {
      operation: "remove_certification_record",
      recordId: "certification_1",
    },
  },
  upsert_project_record: {
    input: {
      operation: "upsert_project_record",
      record: { name: "Ops Dashboard" },
    },
    expected: {
      operation: "upsert_project_record",
      record: {
        id: null,
        name: "Ops Dashboard",
      },
    },
  },
  remove_project_record: {
    input: { operation: "remove_project_record", recordId: "project_1" },
    expected: { operation: "remove_project_record", recordId: "project_1" },
  },
  upsert_link_record: {
    input: {
      operation: "upsert_link_record",
      record: {
        label: "Portfolio",
        url: "https://alexvanguard.example.com",
        kind: "portfolio",
      },
    },
    expected: {
      operation: "upsert_link_record",
      record: {
        id: null,
        label: "Portfolio",
        url: "https://alexvanguard.example.com",
        kind: "portfolio",
      },
    },
  },
  remove_link_record: {
    input: { operation: "remove_link_record", recordId: "link_1" },
    expected: { operation: "remove_link_record", recordId: "link_1" },
  },
  upsert_language_record: {
    input: {
      operation: "upsert_language_record",
      record: { language: "Albanian", proficiency: "Native" },
    },
    expected: {
      operation: "upsert_language_record",
      record: {
        id: null,
        language: "Albanian",
        proficiency: "Native",
      },
    },
  },
  remove_language_record: {
    input: { operation: "remove_language_record", recordId: "language_1" },
    expected: { operation: "remove_language_record", recordId: "language_1" },
  },
  upsert_proof_point: {
    input: {
      operation: "upsert_proof_point",
      record: {
        title: "Cut checkout latency",
        claim: "Reduced p95 checkout latency by 40 percent.",
      },
    },
    expected: {
      operation: "upsert_proof_point",
      record: {
        id: null,
        title: "Cut checkout latency",
        claim: "Reduced p95 checkout latency by 40 percent.",
      },
    },
  },
  remove_proof_point: {
    input: { operation: "remove_proof_point", recordId: "proof_point_1" },
    expected: { operation: "remove_proof_point", recordId: "proof_point_1" },
  },
  upsert_reusable_answer: {
    input: {
      operation: "upsert_reusable_answer",
      record: {
        kind: "notice_period",
        label: "Notice period",
        question: "When can you start?",
        answer: "Two weeks after signing.",
      },
    },
    expected: {
      operation: "upsert_reusable_answer",
      record: {
        id: null,
        kind: "notice_period",
        label: "Notice period",
        question: "When can you start?",
        answer: "Two weeks after signing.",
      },
    },
  },
  remove_reusable_answer: {
    input: { operation: "remove_reusable_answer", recordId: "answer_1" },
    expected: { operation: "remove_reusable_answer", recordId: "answer_1" },
  },
  resolve_review_items: {
    input: {
      operation: "resolve_review_items",
      reviewItemIds: ["review_item_1"],
      resolutionStatus: "confirmed",
    },
    expected: {
      operation: "resolve_review_items",
      reviewItemIds: ["review_item_1"],
      resolutionStatus: "confirmed",
    },
  },
};

describe("propose_profile_operations model-tool harness", () => {
  test("tells the model to omit unchanged record fields and reserve empty values for explicit clears", async () => {
    const deterministic = createDeterministicJobFinderAiClient();
    let systemPrompt = "";
    const client: AgentCapableJobFinderAiClient = {
      ...deterministic,
      chatWithTools(messages) {
        systemPrompt = messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join(" ");
        return Promise.resolve({ toolCalls: [finishCall("finish")] });
      },
    };

    await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest(
        "Change only the location on my current role.",
      ),
    });

    expect(systemPrompt).toContain("Omit every unchanged field");
    expect(systemPrompt).toContain(
      "Send null or an empty list only when the person explicitly asks to clear that field",
    );
    expect(systemPrompt).toContain(
      "map the Settings names Light to conservative, Tailored to balanced, Aggressive to aggressive",
    );
    // Original is reachable from the chat; the old prompt said it was not.
    expect(systemPrompt).toContain("propose set_resume_approach");
    expect(systemPrompt).not.toContain("cannot be changed through");
  });

  for (const [operationName, testCase] of Object.entries(operationCases)) {
    test(`accepts ${operationName} and wraps it in one runtime-owned review-only group`, async () => {
      const client = createScriptedToolClient([
        {
          toolCalls: [
            call("set_response_content", `${operationName}_content`, {
              content: "I prepared a grounded profile change for review.",
            }),
            proposeCall(`${operationName}_propose`, [testCase.input]),
            finishCall(`${operationName}_finish`),
          ],
        },
      ]);

      const reply = await runProfileCopilotAgentTask({
        client,
        request: createCopilotRequest(
          `Apply the ${operationName} change I asked about.`,
        ),
      });

      expect(reply.executionReceipt?.stopReason).toBe("completed");
      expect(reply.patchGroups).toHaveLength(1);
      const group = reply.patchGroups[0];
      expect(group?.applyMode).toBe("needs_review");
      expect(group?.id).toMatch(/^profile_proposal_/);
      expect(group?.summary).toBe("Proposed profile update for review.");
      expect(Number.isNaN(Date.parse(group?.createdAt ?? ""))).toBe(false);
      expect(group?.operations).toEqual([testCase.expected]);
    });
  }

  test("groups several heterogeneous operations from one call into one review-only group", async () => {
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall("multi_propose", [
            operationCases.replace_identity_fields.input,
            operationCases.upsert_language_record.input,
            operationCases.remove_proof_point.input,
            operationCases.resolve_review_items.input,
          ]),
          finishCall("multi_finish"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest(
        "Refresh my headline, add Albanian, drop the stale proof point, and confirm the flagged review items.",
      ),
    });

    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.patchGroups).toHaveLength(1);
    const group = reply.patchGroups[0];
    expect(group?.applyMode).toBe("needs_review");
    expect(group?.operations).toEqual([
      operationCases.replace_identity_fields.expected,
      operationCases.upsert_language_record.expected,
      operationCases.remove_proof_point.expected,
      operationCases.resolve_review_items.expected,
    ]);
  });

  test("rejects an unknown operation, reports repair issues, and recovers on the next attempt", async () => {
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall("invalid_propose", [
            {
              operation: "replace_magic_salary_fields",
              value: { magicNumber: 999999 },
            },
          ]),
        ],
      },
      {
        toolCalls: [
          proposeCall("repaired_propose", [
            operationCases.replace_identity_fields.input,
          ]),
          finishCall("repaired_finish"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest("Update my headline."),
    });

    const rejected = reply.executionReceipt?.toolReceipts.find(
      (receipt) => receipt.toolName === "propose_profile_operations",
    );
    expect(rejected).toMatchObject({ outcome: "rejected" });
    expect(rejected?.validationIssues.length ?? 0).toBeGreaterThan(0);
    expect(reply.executionReceipt?.repairAttempts).toBe(1);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations).toEqual([
      operationCases.replace_identity_fields.expected,
    ]);
  });

  test("rejects an id-less field-only record update and repairs it with the existing id", async () => {
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall("missing_id", [
            {
              operation: "upsert_experience_record",
              record: { achievements: ["Mentored two frontend engineers."] },
            },
          ]),
        ],
      },
      {
        toolCalls: [
          proposeCall("repaired_id", [
            {
              operation: "upsert_experience_record",
              record: {
                id: "experience_1",
                achievements: ["Mentored two frontend engineers."],
              },
            },
          ]),
          finishCall("finish_repaired_id"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest("Add one bullet to my existing role."),
    });

    expect(reply.executionReceipt?.repairAttempts).toBe(1);
    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.patchGroups[0]?.operations).toEqual([
      {
        operation: "upsert_experience_record",
        record: {
          id: "experience_1",
          achievements: ["Mentored two frontend engineers."],
        },
      },
    ]);
  });

  test("rejects a new role with a title but no employer and repairs the split", async () => {
    // Splitting "Acme" used to add a stray employer-less "Backend Engineer"
    // card beside the untouched original.
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall("title_only", [
            {
              operation: "upsert_experience_record",
              record: { title: "Backend Engineer", endDate: "2022-12" },
            },
          ]),
        ],
      },
      {
        toolCalls: [
          proposeCall("repaired_split", [
            {
              operation: "upsert_experience_record",
              record: {
                id: "experience_1",
                title: "Backend Engineer",
                endDate: "2022-12",
                isCurrent: false,
              },
            },
            {
              operation: "upsert_experience_record",
              record: {
                companyName: "Signal Systems",
                title: "Senior Backend Engineer",
                startDate: "2023-01",
                isCurrent: true,
              },
            },
          ]),
          finishCall("finish_repaired_split"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest(
        "Split my role: Backend Engineer until December 2022, then Senior Backend Engineer.",
      ),
    });

    expect(reply.executionReceipt?.repairAttempts).toBe(1);
    const rejected = reply.executionReceipt?.toolReceipts.find(
      (receipt) =>
        receipt.toolName === "propose_profile_operations" &&
        receipt.outcome === "rejected",
    );
    expect(
      rejected?.validationIssues.some((issue) =>
        issue.message.includes("must include both companyName and title"),
      ),
    ).toBe(true);
    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations).toHaveLength(2);
  });

  test("sends a split back when a bullet would stay on the old card and land on the new one", async () => {
    const bullets = [
      "Led the settlement migration.",
      "Cut reconciliation time to 35 minutes.",
    ];
    const profile = {
      ...createProfile(),
      experiences: [
        {
          id: "experience_acme",
          companyName: "Acme Payments",
          companyUrl: null,
          title: "Senior Backend Engineer",
          employmentType: null,
          location: "Lisbon, Portugal",
          workMode: [],
          startDate: "2021-03",
          endDate: null,
          isCurrent: true,
          isDraft: false,
          summary: null,
          achievements: bullets,
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    };
    const newCard = {
      operation: "upsert_experience_record",
      record: {
        companyName: "Acme Payments",
        title: "Senior Backend Engineer",
        startDate: "2023-01",
        isCurrent: true,
        achievements: bullets,
      },
    };
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall("copied_bullets", [
            {
              operation: "upsert_experience_record",
              record: {
                id: "experience_acme",
                title: "Backend Engineer",
                endDate: "2022-12",
                isCurrent: false,
              },
            },
            newCard,
          ]),
          finishCall("finish_copied"),
        ],
      },
      {
        toolCalls: [
          proposeCall("moved_bullets", [
            {
              operation: "upsert_experience_record",
              record: {
                id: "experience_acme",
                title: "Backend Engineer",
                endDate: "2022-12",
                isCurrent: false,
                achievements: [],
              },
            },
            newCard,
          ]),
          finishCall("finish_moved"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: {
        ...createCopilotRequest("Split my Acme role at January 2023."),
        profile,
      },
    });

    expect(reply.executionReceipt?.stopReason).toBe("completed");
    // The duplicated proposal was never kept: only the repaired one lands.
    expect(reply.patchGroups.at(-1)?.operations[0]).toMatchObject({
      operation: "upsert_experience_record",
      record: { id: "experience_acme", achievements: [] },
    });
    expect(findBulletsOnTwoCards(profile, reply.patchGroups.slice(-1))).toEqual(
      [],
    );
    expect(
      findBulletsOnTwoCards(profile, [
        {
          id: "group",
          summary: "Split",
          applyMode: "needs_review",
          createdAt: "2026-09-23T10:00:00.000Z",
          operations: [
            {
              operation: "upsert_experience_record",
              record: {
                id: "experience_acme",
                title: "Backend Engineer",
                endDate: "2022-12",
                isCurrent: false,
              },
            },
            {
              operation: "upsert_experience_record",
              record: {
                id: null,
                companyName: "Acme Payments",
                title: "Senior Backend Engineer",
                achievements: bullets,
              },
            },
          ],
        },
      ] as never).map((issue) => issue.code),
    ).toEqual(["bullet_on_two_cards", "bullet_on_two_cards"]);
  });

  test("fails safe when every proposal is invalid: no group ever lands", async () => {
    const invalidPropose = proposeCall("invalid", [
      { operation: "replace_identity_fields" },
    ]);
    const client = createScriptedToolClient([
      { toolCalls: [invalidPropose] },
      { toolCalls: [invalidPropose] },
      { toolCalls: [invalidPropose] },
      { toolCalls: [invalidPropose] },
      { toolCalls: [invalidPropose] },
      { toolCalls: [invalidPropose] },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest("Update my headline."),
    });

    expect(reply.executionReceipt?.stopReason).not.toBe("completed");
    expect(reply.patchGroups).toEqual([]);
    const proposeReceipts =
      reply.executionReceipt?.toolReceipts.filter(
        (receipt) => receipt.toolName === "propose_profile_operations",
      ) ?? [];
    expect(proposeReceipts.length).toBeGreaterThan(0);
    for (const receipt of proposeReceipts) {
      expect(receipt.outcome).toBe("rejected");
    }
  });

  test("strips model-supplied metadata so the group stays runtime-owned and needs_review", async () => {
    const client = createScriptedToolClient([
      {
        toolCalls: [
          proposeCall(
            "metadata_propose",
            [
              {
                ...operationCases.replace_identity_fields.input,
                id: "model_operation_id",
                applyMode: "applied",
                createdAt: "1999-01-01T00:00:00.000Z",
              },
            ],
            {
              id: "model_group_id",
              applyMode: "rejected",
              createdAt: "1999-01-01T00:00:00.000Z",
              status: "applied",
            },
          ),
          finishCall("metadata_finish"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: createCopilotRequest("Update my headline."),
    });

    expect(reply.executionReceipt?.stopReason).toBe("completed");
    expect(reply.patchGroups).toHaveLength(1);
    const group = reply.patchGroups[0];
    expect(group?.id).toMatch(/^profile_proposal_/);
    expect(group?.applyMode).toBe("needs_review");
    expect(group?.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(group?.createdAt ?? ""))).toBe(false);
    expect(group?.operations).toEqual([
      operationCases.replace_identity_fields.expected,
    ]);
  });
});

describe("the saved resume level and volunteer level in the Profile Copilot", () => {
  function captureMessages() {
    const deterministic = createDeterministicJobFinderAiClient();
    const captured = { system: "", user: "" };
    const client: AgentCapableJobFinderAiClient = {
      ...deterministic,
      chatWithTools(messages) {
        captured.system = messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join(" ");
        captured.user = messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join(" ");
        return Promise.resolve({ toolCalls: [finishCall("finish")] });
      },
    };
    return { captured, client };
  }

  test("set_resume_approach proposes the level as one review-only card", async () => {
    const client = createScriptedToolClient([
      {
        toolCalls: [
          call("set_response_content", "level_content", {
            content:
              "Original sends your imported file unchanged, so I prepared a switch to Light.",
          }),
          call("set_resume_approach", "level_propose", {
            summary: "Use Light resumes for new jobs",
            approach: "conservative",
          }),
          finishCall("level_finish"),
        ],
      },
    ]);

    const reply = await runProfileCopilotAgentTask({
      client,
      request: {
        ...createCopilotRequest("Make my resume shorter."),
        resumeApproach: "original_resume",
      },
    });

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]).toMatchObject({
      applyMode: "needs_review",
      operations: [{ operation: "set_resume_approach", value: "conservative" }],
    });
  });

  test("the model is handed the saved level, Original included", async () => {
    const { captured, client } = captureMessages();

    await runProfileCopilotAgentTask({
      client,
      request: {
        ...createCopilotRequest("Make my resume shorter."),
        resumeApproach: "original_resume",
      },
    });

    expect(captured.user).toContain("resumeApproach");
    expect(captured.user).toContain("original_resume");
  });

  test("each volunteer level is a distinct instruction placed after the rule about gaps", async () => {
    const prompts = new Map<string, string>();
    for (const initiative of ["answer_only", "suggest", "proactive"] as const) {
      const { captured, client } = captureMessages();
      await runProfileCopilotAgentTask({
        client,
        request: {
          ...createCopilotRequest("Add Jest to my skills."),
          assistantBehavior: { initiative, replyStyle: "brief" },
        },
      });
      prompts.set(initiative, captured.system);
    }

    const chosen = {
      answer_only: "the person chose Only what I ask",
      suggest: "the person chose Suggest a little",
      proactive: "the person chose Proactive",
    } as const;
    for (const [initiative, phrase] of Object.entries(chosen)) {
      const prompt = prompts.get(initiative) ?? "";
      expect(prompt).toContain(phrase);
      // The Profile rule that every mentioned gap must be proposed reads as a
      // mandate to volunteer; the person's level has the last word after it.
      expect(prompt.indexOf(phrase)).toBeGreaterThan(
        prompt.indexOf("Every gap or improvement you mention"),
      );
      for (const [otherInitiative, otherPhrase] of Object.entries(chosen)) {
        if (otherInitiative !== initiative) {
          expect(prompt).not.toContain(otherPhrase);
        }
      }
    }
    expect(prompts.get("answer_only")).toContain(
      "Do not propose, mention, or ask about anything else",
    );
    expect(prompts.get("proactive")).toContain(
      "add up to three further improvements, every time",
    );
    // A built-app run on a profile with no skills: Proactive offered a
    // target-role tidy-up and never raised the empty skills list.
    expect(prompts.get("proactive")).toContain(
      "An empty skills list is the first gap to raise",
    );
    expect(prompts.get("answer_only")).not.toContain("empty skills list");
    expect(prompts.get("suggest")).not.toContain("empty skills list");
  });
});
