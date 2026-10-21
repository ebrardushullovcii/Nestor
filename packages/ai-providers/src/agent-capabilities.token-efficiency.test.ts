import { expect, test } from "vitest";

import {
  buildWriterProfileOutline,
  runResumeGenerationAgentTask,
} from "./agent-capabilities";
import { createDeterministicJobFinderAiClient } from "./deterministic";
import { buildResumeGenerationEvidenceCatalog } from "./resume-generation-grounding";
import type {
  AgentCapableJobFinderAiClient,
  CreateResumeDraftInput,
} from "./shared";
import { ResumeProposalValidationError } from "./shared";
import {
  createJobPosting,
  createPreferences,
  createProfile,
  createSettings,
} from "./test-fixtures";

type VisibleContext = Record<string, unknown> & {
  candidateProfile: {
    baseResume: {
      textContent?: string | null;
      textContentEvidenceRef?: string;
    };
  };
  groundingEvidence: {
    items: Array<{
      id: string;
      text: string;
      scope: string;
      profileRecordId: string | null;
    }>;
  };
};

async function captureGeneration(request: CreateResumeDraftInput) {
  const payloads: VisibleContext[] = [];
  const toolValues = new Map<string, Record<string, unknown>>();
  let turn = 0;
  const client: AgentCapableJobFinderAiClient = {
    ...createDeterministicJobFinderAiClient(),
    chatWithTools(messages) {
      payloads.push(
        JSON.parse(
          messages.find((message) => message.role === "user")!.content,
        ) as VisibleContext,
      );
      for (const message of messages.filter((entry) => entry.role === "tool")) {
        const result = JSON.parse(message.content) as {
          inlineItems?: Array<Record<string, unknown>>;
        };
        if (result.inlineItems?.[0])
          toolValues.set(message.toolCallId, result.inlineItems[0]);
      }
      return Promise.resolve({
        toolCalls: [
          {
            id: `compose_${++turn}`,
            type: "function" as const,
            function: {
              name: "compose_resume_proposal",
              arguments: JSON.stringify({
                proposal: {
                  summary: {
                    text: "Maintained a synthetic migration ledger.",
                    evidenceRefs: ["baseResume:text"],
                  },
                },
              }),
            },
          },
        ],
      });
    },
  };
  const draft = await runResumeGenerationAgentTask({
    client,
    request,
    substantivePrompt: "Write a resume grounded in the supplied evidence IDs.",
  });
  return { payloads, toolValues, draft };
}

function requestWithResume(profileText: string, selectedText = profileText) {
  const profile = createProfile();
  profile.baseResume.textContent = profileText;
  return {
    profile,
    job: createJobPosting(),
    settings: createSettings(),
    searchPreferences: createPreferences(),
    resumeText: selectedText,
    evidence: {
      summary: ["Unique imported summary absent from the saved profile."],
      candidateSummary: ["Unique imported background detail."],
      experience: ["Unique imported role evidence."],
      skills: ["Unique imported skill"],
      keywords: ["Unique imported keyword"],
    },
  } satisfies CreateResumeDraftInput;
}

test("the selected raw resume appears once per writer request with resolvable evidence references", async () => {
  const marker = "SYNTHETIC_SELECTED_RESUME_SOURCE";
  const resumeText =
    `${marker}\nMaintained a synthetic migration ledger.\n` +
    "Complete unabridged synthetic career detail. ".repeat(300);
  const request = requestWithResume(resumeText);
  const canonicalEvidence = buildResumeGenerationEvidenceCatalog(request);
  const canonicalRequest = structuredClone(request);
  const { payloads, draft } = await captureGeneration(request);
  for (const payload of payloads) {
    expect(payload.baseResumeEvidenceRef).toBe("baseResume:text");
    expect(payload).not.toHaveProperty("baseResumeText");
    expect(payload.candidateProfile.baseResume).not.toHaveProperty(
      "textContent",
    );
    expect(payload.candidateProfile.baseResume.textContentEvidenceRef).toBe(
      "baseResume:text",
    );
    const source = payload.groundingEvidence.items.find(
      (item) => item.id === "baseResume:text",
    )!;
    expect(source.text).toBe(resumeText);
    expect(payload.groundingEvidence.items.map((item) => item.id)).toEqual(
      canonicalEvidence.map((item) => item.id),
    );
    expect(
      payload.groundingEvidence.items.filter((item) => item.id !== source.id),
    ).toEqual(canonicalEvidence.filter((item) => item.id !== source.id));
    expect(JSON.stringify(payload).split(marker)).toHaveLength(2);
  }
  const payload = payloads[0]!;
  const withoutReference = { ...payload };
  delete withoutReference.baseResumeEvidenceRef;
  const before = JSON.stringify({
    ...withoutReference,
    baseResumeText: resumeText,
    candidateProfile: request.profile,
    groundingEvidence: { version: 1, items: canonicalEvidence },
  });
  const after = JSON.stringify(payload);
  console.info(
    "Synthetic resume current-task payload characters:",
    JSON.stringify({
      before: before.length,
      after: after.length,
      removed: before.length - after.length,
    }),
  );
  expect(before.split(marker)).toHaveLength(4);
  expect(before.length - after.length).toBeGreaterThan(
    2 * resumeText.length - 200,
  );
  expect(request).toEqual(canonicalRequest);
  expect(draft.summary).toBe("Maintained a synthetic migration ledger.");
});

test("a strategy-selected resume retains its own evidence while a distinct profile resume stays complete", async () => {
  const selectedText =
    "SELECTED_STRATEGY_SOURCE\nMaintained a synthetic migration ledger.";
  const profileText =
    "ORIGINAL_PROFILE_SOURCE\nDistinct saved career evidence.";
  const request = requestWithResume(profileText, selectedText);
  const { payloads } = await captureGeneration(request);
  for (const payload of payloads) {
    expect(payload.candidateProfile).toEqual(
      buildWriterProfileOutline(request.profile, {
        textContent: profileText,
      }),
    );
    expect(payload.groundingEvidence.items).toEqual(
      buildResumeGenerationEvidenceCatalog(request),
    );
    expect(payload.baseResumeEvidenceRef).toBe("baseResume:text");
    expect(
      JSON.stringify(payload).split("SELECTED_STRATEGY_SOURCE"),
    ).toHaveLength(2);
    expect(
      JSON.stringify(payload).split("ORIGINAL_PROFILE_SOURCE"),
    ).toHaveLength(2);
  }
});

test("a rendered check ends the writer; a refused proposal's result names the issues, never the resume body", async () => {
  let renders = 0;
  const request: CreateResumeDraftInput = {
    ...requestWithResume("Maintained a synthetic migration ledger."),
    renderPreview: () => {
      if (++renders === 1)
        throw new ResumeProposalValidationError(
          "The synthetic render refused this proposal.",
          [
            {
              code: "synthetic_refusal",
              message: "Synthetic refusal.",
              path: ["proposal", "summary"],
            },
          ],
        );
      return Promise.resolve({
        templateId: "classic_ats",
        pageCount: 2,
        warnings: ["Synthetic renderer warning"],
        fileName: "synthetic-preview.pdf",
        requiredModelRepairs: [
          {
            id: "issue_claim_grounding_summary",
            severity: "error" as const,
            category: "unsupported_claim" as const,
            sectionId: "summary",
            entryId: null,
            bulletId: null,
            message: "Saved evidence does not back this wording.",
          },
        ],
        personConfirmationCount: 2,
      });
    },
  };
  const { payloads, toolValues, draft } = await captureGeneration(request);
  // The refusal costs one more call; the flagged render after it does not.
  expect(payloads).toHaveLength(2);
  const check = toolValues.get("compose_1")!;
  expect(check).toMatchObject({
    validationIssues: [expect.objectContaining({ code: "synthetic_refusal" })],
  });
  for (const field of [
    "fullText",
    "summary",
    "experienceEntries",
    "projectEntries",
    "educationEntries",
    "certificationEntries",
    "coreSkills",
    "targetedKeywords",
    "resume",
  ])
    expect(check).not.toHaveProperty(field);
  expect(JSON.stringify(check)).not.toContain(draft.fullText);
});
