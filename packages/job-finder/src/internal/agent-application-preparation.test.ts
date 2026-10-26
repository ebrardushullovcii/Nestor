import type { LLMClient } from "@nestor/browser-agent";
import {
  ApplicationAuthorityEnvelopeSchema,
  AiBehaviorPreferenceSchema,
  ApplicationReviewCardSchema,
  serializeApplicationAuthorityDecisionPolicyForDigest,
} from "@nestor/contracts";
import { createHash } from "node:crypto";

import type { ApplySubmissionHandoff } from "./apply-submission-handoff";
import type { ApplyPageSession, RawApplyPage } from "@nestor/contracts";
import { CandidateProfileSchema, SavedJobSchema } from "@nestor/contracts";
import type { ExecuteApplicationFlowInput } from "@nestor/browser-runtime";
import { describe, expect, test, vi } from "vitest";

import {
  buildApplyReviewCard,
  mergeApplyReviewCards,
  createApplyFormPreparer as createProductionApplyFormPreparer,
  resolveApplicationDocumentMimeType,
  resolveApplicationPreparationTarget,
  resolveApplySiteLabel,
  runAgentApplicationPreparation as runProductionApplicationPreparation,
  applyingConversationKey,
  toApplyDocuments,
  toApplyLlmClient,
} from "./agent-application-preparation";

// This file tests the preparation/store seam. Give its scripted writers a
// complete question read; classifier failures and meaning are tested in the
// browser-agent gate regressions, not by returning "finish" to the reader.
function fixtureQuestionReadings(client: LLMClient): LLMClient {
  return {
    chatWithTools: (messages, tools, options) => {
      if (tools[0]?.function.name !== "report_question_kinds")
        return client.chatWithTools(messages, tools, options);
      const questions = JSON.parse(String(messages[1]?.content)) as Array<{
        index: number;
        question: string;
      }>;
      const { sources } = JSON.parse(String(messages[2]?.content)) as {
        sources: Array<{
          id: string;
          purpose: string;
          question?: string;
          country: string | null;
        }>;
      };
      return Promise.resolve({
        toolCalls: [
          {
            id: "question-read",
            type: "function",
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: questions.map((question) => question.index),
                flagged: [],
                tags: questions.map((question) => {
                  const saved = sources.find(
                    (source) =>
                      source.purpose === "saved" &&
                      source.question === question.question,
                  );
                  const label = question.question
                    .split(" — ")
                    .at(-1)
                    ?.toLowerCase();
                  const id =
                    saved?.id ??
                    (label === "full name"
                      ? "profile.fullName"
                      : label === "email"
                        ? "profile.email"
                        : null);
                  return {
                    index: question.index,
                    kind: question.question.includes("authorized")
                      ? "work_auth"
                      : "other",
                    country:
                      saved?.country ??
                      sources.find((source) => source.id === "posting.location")
                        ?.country ??
                      null,
                    sourceId: id,
                  };
                }),
              }),
            },
          },
        ],
      });
    },
  };
}

function runAgentApplicationPreparation(
  input: Parameters<typeof runProductionApplicationPreparation>[0],
) {
  return runProductionApplicationPreparation({
    ...input,
    llmClient: fixtureQuestionReadings(input.llmClient),
  });
}
function createApplyFormPreparer(
  input: Parameters<typeof createProductionApplyFormPreparer>[0],
) {
  const chat = input.aiClient.chatWithTools;
  return createProductionApplyFormPreparer({
    ...input,
    aiClient: chat
      ? {
          ...input.aiClient,
          chatWithTools: fixtureQuestionReadings({ chatWithTools: chat })
            .chatWithTools,
        }
      : input.aiClient,
  });
}

describe("resolveApplicationDocumentMimeType", () => {
  test.each([
    ["official-resume.txt", "text/plain"],
    ["official-resume.PDF", "application/pdf"],
    [
      "official-resume.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["official-resume", "application/octet-stream"],
  ])("reports the bytes' file type for %s", (fileName, expected) => {
    expect(resolveApplicationDocumentMimeType(fileName)).toBe(expected);
  });
});

describe("resolveApplicationPreparationTarget", () => {
  test("prefers the exact live wizard page over listing and stale checkpoint URLs", () => {
    const facts = executionInput();
    facts.job = SavedJobSchema.parse({
      ...facts.job,
      canonicalUrl: "https://apply.example.test/jobs/one",
      applicationUrl: "https://apply.example.test/jobs/one",
    });
    facts.startingUrl =
      "https://apply.example.test/apply/one?stage=application";

    expect(
      resolveApplicationPreparationTarget({
        executionInput: facts,
        currentUrl: "https://apply.example.test/apply/one?stage=review#step-4",
      }),
    ).toEqual({
      targetUrl: "https://apply.example.test/apply/one?stage=review#step-4",
      isContinuation: true,
    });
  });

  test("does not trust a bound page that drifted outside the authorized application origins", () => {
    const facts = executionInput();
    facts.startingUrl = "https://apply.example.test/form?stage=application";

    expect(
      resolveApplicationPreparationTarget({
        executionInput: facts,
        currentUrl: "https://unrelated.example.test/account",
      }),
    ).toEqual({
      targetUrl: "https://apply.example.test/form?stage=application",
      isContinuation: true,
    });
  });
});

/**
 * The seam between the apply loop and the record Job Finder keeps.
 *
 * What matters here is that the person's own words survive the trip: the
 * questions that stopped the run, the plain sentence about why, and the one
 * thing they are being asked to do next.
 */

const PAGE_URL = "https://apply.example.test/form";

function envelopeFor(mode: "confirm_before_submit" | "autonomous_submit") {
  const content = {
    version: 1 as const,
    answerPolicy: {
      approvedAnswerSnapshot: { revision: 1, digest: "b".repeat(64) },
      unknownRequiredQuestion: "pause_for_user" as const,
      unknownEligibility: "pause_for_user" as const,
      unknownLegalRequirement: "pause_for_user" as const,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
    },
    stopConditions: {
      unavailableCredentials: "pause_for_user" as const,
      loginRequired: "pause_for_user" as const,
      mfaRequired: "pause_for_user" as const,
      captcha: "pause_for_user" as const,
      antiBot: "pause_for_user" as const,
      accountCreation: "pause_for_user" as const,
      staleObservation: "pause_for_user" as const,
      ambiguousFinalControl: "pause_for_user" as const,
      originDrift: "pause_for_user" as const,
      outcomeUncertain: "stop_no_retry" as const,
    },
  };
  return ApplicationAuthorityEnvelopeSchema.parse({
    id: "authority_test",
    mode,
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: ["job_test"] },
    maxApplicationsPerRun: 10,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: ["a".repeat(64)],
    allowedOrigins: ["https://apply.example.test"],
    createdAt: "2026-09-01T10:00:00.000Z",
    expiresAt: "2026-09-20T10:00:00.000Z",
    revokedAt: null,
    decisionPolicy: {
      ...content,
      revision: 1,
      digest: createHash("sha256")
        .update(serializeApplicationAuthorityDecisionPolicyForDigest(content))
        .digest("hex"),
    },
  });
}

function rawPage(bodyText: string): RawApplyPage {
  return {
    url: PAGE_URL,
    title: "Apply",
    bodyText,
    // One ordinary question, so the page reads as the form rather than as a
    // listing the run would have to walk away from first.
    controls: [
      {
        index: 0,
        tagName: "input",
        inputType: "text",
        role: "",
        id: "f0",
        name: "f0",
        label: "Full name",
        groupLabel: "",
        placeholder: "",
        autocomplete: "",
        required: false,
        invalid: false,
        validationMessage: "",
        disabled: false,
        readOnly: false,
        visible: true,
        value: "",
        checked: false,
        multiple: false,
        options: [],
        selectedOptionLabel: "",
      },
    ],
    actions: [
      { index: 0, label: "Send application", visible: true, disabled: false },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
}

/** One open page that reports a one-question form and accepts every write. */
function session(bodyText = "Apply for the role"): ApplyPageSession {
  return {
    readPage: () => Promise.resolve(rawPage(bodyText)),
    navigate: () => Promise.resolve({ ok: true, url: PAGE_URL }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    pressKey: (_ref, key) => Promise.resolve({ ok: true, observedValue: key }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: PAGE_URL }),
    readText: () => Promise.resolve(bodyText),
    fillText: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () => Promise.resolve({ ok: true, url: PAGE_URL }),
    installPrepareOnlyGuard: () => Promise.resolve(),
    readBlockedAttempt: () => Promise.resolve(null),
    registerPreparedValue: () => Promise.resolve(),
    openIntermediateWriteWindow: () => Promise.resolve(),
    closeIntermediateWriteWindow: () => Promise.resolve(),
    closeUploadWindow: () => Promise.resolve(),
    clickAuthorizedFormAction: () =>
      Promise.resolve({ ok: true, observedValue: "clicked" }),
    readIntermediateWriteCount: () => 0,
    checkServiceWorker: () => Promise.resolve(null),
  };
}

function testJob() {
  return SavedJobSchema.parse({
    id: "job_test",
    source: "target_site" as const,
    sourceJobId: "job_test",
    discoveryMethod: "catalog_seed" as const,
    collectionMethod: "fallback_search" as const,
    canonicalUrl: "https://apply.example.test/form",
    applicationUrl: "https://apply.example.test/form",
    title: "Senior Engineer",
    company: "Example Co",
    location: "Remote",
    workMode: ["remote" as const],
    applyPath: "external_redirect" as const,
    easyApplyEligible: false,
    postedAt: "2026-03-20T09:00:00.000Z",
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    detailQuality: "detail_enriched" as const,
    summary: "Build resilient workflows.",
    description: "Upload a resume and review the application.",
    keySkills: ["TypeScript"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    titleTriageOutcome: "pass" as const,
    sourceIntelligence: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: [],
    benefits: [],
    status: "approved" as const,
    matchAssessment: {
      score: 91,
      reasons: ["Strong fit"],
      gaps: [],
      recommendation: "review_before_applying" as const,
      recommendationRationale: "Test fixture requires explicit review.",
      requirements: [],
    },
    provenance: [],
  });
}

function executionInput(): Omit<
  ExecuteApplicationFlowInput,
  "prepareApplicationForm"
> {
  return {
    job: testJob(),
    resumeArtifact: {
      id: "resume_artifact_test",
      jobId: "job_test",
      source: "tailored_export",
      sourceDocumentId: null,
      exportArtifactId: "export_test",
      fileName: "robin-ashford-resume.pdf",
      filePath: "/tmp/does-not-need-to-exist.pdf",
      sha256: "b".repeat(64),
      approvedAt: "2026-09-14T09:30:00.000Z",
    },
    profile: CandidateProfileSchema.parse({
      id: "candidate_test",
      firstName: "Robin",
      lastName: "Ashford",
      fullName: "Robin Ashford",
      headline: "Platform engineer",
      summary: "Builds dependable internal tools.",
      currentLocation: "Manchester",
      yearsExperience: 8,
      email: "robin.ashford@example.test",
      baseResume: {
        id: "resume_test",
        fileName: "resume.txt",
        uploadedAt: "2026-09-01T09:00:00.000Z",
        textContent: "8 years of platform engineering.",
        textUpdatedAt: "2026-09-01T09:00:00.000Z",
        extractionStatus: "ready",
      },
    }),
    settings: {
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: false,
      discoveryOnly: false,
    },
    mode: "prepare_only",
  };
}

/** A model that looks, then says only the person can go further. */
function modelThatNeedsThePerson(reason: string): LLMClient {
  let calls = 0;
  return {
    chatWithTools: () => {
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: {
              name: "finish",
              arguments: JSON.stringify({ reason, needsPerson: true }),
            },
          },
        ],
      });
    },
  };
}

function modelThatFinishes(reason = "Nothing left to fill in"): LLMClient {
  let calls = 0;
  return {
    chatWithTools: () => {
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: {
              name: "finish",
              arguments: JSON.stringify({ reason }),
            },
          },
        ],
      });
    },
  };
}

function modelThatGetsStuck(): LLMClient {
  return {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "call_stuck",
            type: "function" as const,
            function: {
              name: "finish",
              arguments: JSON.stringify({
                reason: "The assistant did not answer in time",
                stuck: true,
              }),
            },
          },
        ],
      }),
  };
}

describe("agent application preparation seam", () => {
  test("gives a continuation the runtime's live bound page instead of stale saved targets", async () => {
    const facts = executionInput();
    facts.job = SavedJobSchema.parse({
      ...facts.job,
      canonicalUrl: "https://apply.example.test/jobs/one",
      applicationUrl: "https://apply.example.test/jobs/one",
    });
    facts.startingUrl =
      "https://apply.example.test/apply/one?stage=application";
    const liveWizardUrl =
      "https://apply.example.test/apply/one?stage=review#step-4";
    facts.instructions = [
      'Answer to "Street address": 1 Example Road',
      'Answer to "Postal code": SW1A 1AA',
    ];
    const seenMessages: string[] = [];

    const result = await runAgentApplicationPreparation({
      session: session(),
      currentUrl: liveWizardUrl,
      executionInput: facts,
      llmClient: {
        chatWithTools: (messages) => {
          seenMessages.push(JSON.stringify(messages));
          return Promise.resolve({
            toolCalls: [
              {
                id: "call_finish",
                type: "function" as const,
                function: {
                  name: "finish",
                  arguments: JSON.stringify({
                    reason: "The retained form is complete",
                  }),
                },
              },
            ],
          });
        },
      },
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(seenMessages.join("\n")).toContain(liveWizardUrl);
    expect(seenMessages.join("\n")).toContain("1 Example Road");
    expect(seenMessages.join("\n")).toContain("SW1A 1AA");
    expect(seenMessages.join("\n")).toContain(
      "Do not follow the site header or navigate back to its home page or job listing",
    );
    expect(seenMessages.join("\n")).toContain(
      "without returning to the listing or reloading it",
    );
    expect(result.replay.checkpointUrls[0]).toBe(liveWizardUrl);
  });

  test("a finished prepare-only run becomes a ready record that says nothing was sent", async () => {
    const openSession = session();
    const installPrepareOnlyGuard = vi.spyOn(
      openSession,
      "installPrepareOnlyGuard",
    );

    const facts = executionInput();
    facts.intermediateMutationsAuthorized = true;
    facts.intermediateMutationAllowedOrigins = [];
    facts.applyAllowedOrigins = [new URL(PAGE_URL).origin];
    const result = await runAgentApplicationPreparation({
      session: openSession,
      executionInput: facts,
      llmClient: modelThatFinishes(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(installPrepareOnlyGuard).toHaveBeenCalledWith({
      intermediateMutationsAuthorized: true,
      allowedOrigins: [],
    });
    expect(result.agentTiming?.modelTurns).toBeGreaterThan(0);
    expect(result.agentTiming?.pageReads).toBeGreaterThan(0);
    expect(result.agentTiming?.totalMs).toBe(0);
    expect(result.state).toBe("ready");
    expect(result.submittedAt).toBeNull();
    expect(result.outcome).toBeNull();
    expect(result.detail).toContain("nothing was sent");
    expect(result.blocker).toBeNull();
    expect(result.replay.lastUrl).toBe(PAGE_URL);
  });

  test("preserves an observed closure as a terminal listing blocker", async () => {
    const result = await runAgentApplicationPreparation({
      session: session("This job is no longer accepting applications"),
      executionInput: executionInput(),
      llmClient: modelThatFinishes(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });
    expect(result.blocker?.code).toBe("application_closed");
    expect(result.state).toBe("failed");
  });

  test("a sign-in wall the model reports becomes the record's blocker", async () => {
    // The harness is told the page wants a sign-in; deciding what that means
    // is the model's, and what it says is what the person reads.
    const result = await runAgentApplicationPreparation({
      session: session("You must be signed in to apply"),
      executionInput: executionInput(),
      llmClient: modelThatNeedsThePerson(
        "This site wants you signed in before it will show the form",
      ),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.blocker?.code).toBe("site_login_required");
    expect(result.summary).toBe("The site wants you signed in first.");
    expect(result.blocker?.summary).toBe(result.summary);
    expect(result.detail).toContain("wants you signed in");
  });

  test("an unresolved human check becomes a CAPTCHA handoff even when the model calls the form finished", async () => {
    const result = await runAgentApplicationPreparation({
      session: session(
        "Apply for the role. I am not a robot. Local fake CAPTCHA.",
      ),
      executionInput: executionInput(),
      llmClient: modelThatFinishes(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.state).toBe("paused");
    expect(result.blocker?.code).toBe("requires_manual_review");
    expect(result.blocker?.userActionKind).toBe("captcha");
  });

  test("an assistant stall is a failed attempt to retry, not a request for the person", async () => {
    const result = await runAgentApplicationPreparation({
      session: session(),
      executionInput: executionInput(),
      llmClient: modelThatGetsStuck(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.state).toBe("failed");
    expect(result.blocker?.userActionKind).toBeNull();
    expect(result.nextActionLabel).toContain("Try again");
  });
});

describe("the preparer the browser layer is handed", () => {
  test("names the site the way the person would", () => {
    expect(
      resolveApplySiteLabel({
        targetLabel: "Northwind careers",
        applicationUrl: PAGE_URL,
      }),
    ).toBe("Northwind careers");
    expect(
      resolveApplySiteLabel({
        targetLabel: null,
        applicationUrl: "https://www.boards.example.test/apply",
      }),
    ).toBe("boards.example.test");
    expect(
      resolveApplySiteLabel({ targetLabel: "  ", applicationUrl: "not a url" }),
    ).toBe("this site");
  });

  test("installs the guard and fills the form in when the assistant is available", async () => {
    const openSession = session();
    const installGuard = vi.spyOn(openSession, "installPrepareOnlyGuard");
    const facts = executionInput();

    const prepare = createApplyFormPreparer({
      executionInput: facts,
      aiClient: { chatWithTools: modelThatFinishes().chatWithTools },
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    const result = await prepare({
      session: openSession,
      currentUrl: PAGE_URL,
      startedAt: "2026-09-14T10:00:00.000Z",
    });

    expect(installGuard).toHaveBeenCalledWith({
      intermediateMutationsAuthorized: false,
      allowedOrigins: [],
    });
    expect(result.state).toBe("ready");
    expect(result.submittedAt).toBeNull();
    expect(result.detail).toContain("nothing was sent");
  });

  test("a missing assistant is an outage in the copy, never something to set up", async () => {
    const prepare = createApplyFormPreparer({
      executionInput: executionInput(),
      aiClient: {},
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    const result = await prepare({
      session: session(),
      currentUrl: PAGE_URL,
      startedAt: "2026-09-14T10:00:00.000Z",
    });

    expect(result.state).toBe("failed");
    expect(result.blocker).toBeNull();
    expect(result.detail).toContain("unavailable right now");
    expect(result.detail).toContain("Nothing was changed on the site");
    expect(result.nextActionLabel).toBe("Try this application again shortly");
    // Nothing here asks the person to configure anything.
    expect(result.detail).not.toMatch(/api key|settings|configure|set up/iu);
  });
});

describe("the review card shown before you press send", () => {
  test("a grounding note longer than the card allows is clamped, not a crash", () => {
    const longNote = `Resume line: ${"x".repeat(400)}`;
    const card = buildApplyReviewCard({
      preparedAt: "2026-09-14T10:05:00.000Z",
      siteLabel: "Fixture Board",
      result: {
        outcome: "prepared",
        reason: "Filled in.",
        steps: 3,
        finalUrl: "http://127.0.0.1:47900/apply/a",
        filled: [
          {
            ref: "c5",
            label: "Why do you want to work here?",
            questionKind: "cover_letter",
            answer: {
              value: "Dear team, I build platforms.",
              kind: "cover_letter",
              sourceKind: "generated",
              sourceId: "application.letter",
              provenanceLabel: "the letter written for this application",
              groundedIn: [
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
                longNote,
              ],
            },
            at: "2026-09-14T10:00:00.000Z",
          },
        ],
        attachments: [],
        pauses: [],
        notes: [],
        timeline: [],
        modelTurns: 1,
        readyToSend: null,
      },
    });

    expect(card.letter?.groundedIn).toHaveLength(8);
    expect(card.letter?.groundedIn[0]?.length).toBeLessThanOrEqual(240);
    expect(card.answers[0]?.groundedIn[0]?.endsWith("…")).toBe(true);
  });

  test("shows every answer, where it came from, and what is still waiting on you", () => {
    const card = buildApplyReviewCard({
      preparedAt: "2026-09-14T10:05:00.000Z",
      siteLabel: "Northwind careers",
      result: {
        outcome: "awaiting_your_review",
        reason: "Ready for you to look over and send.",
        steps: 12,
        finalUrl: "https://apply.example.test/form?step=3",
        filled: [
          {
            ref: "c0",
            label: "Email",
            questionKind: "personal_info",
            answer: {
              value: "robin@example.test",
              kind: "personal_info",
              sourceKind: "profile",
              sourceId: "profile.email",
              provenanceLabel: "your email address",
              groundedIn: ["your email address"],
            },
            at: "2026-09-14T10:00:00.000Z",
          },
          {
            ref: "c5",
            label: "Why do you want to work here?",
            questionKind: "cover_letter",
            answer: {
              value: "Dear hiring team, I build platforms.",
              kind: "cover_letter",
              sourceKind: "generated",
              sourceId: "application.letter",
              provenanceLabel: "the letter written for this application",
              groundedIn: ["the resume sent with this application"],
            },
            at: "2026-09-14T10:01:00.000Z",
          },
        ],
        attachments: [
          {
            documentId: "document_resume",
            fileName: "robin-resume.pdf",
            label: "Your CV",
            controlLabel: "Resume/CV",
            at: "2026-09-14T10:02:00.000Z",
          },
        ],
        pauses: [
          {
            code: "question_needs_you",
            summary: 'Job Finder stopped on "Expected salary".',
            question: null,
            blocker: null,
          },
        ],
        notes: [],
        timeline: [],
        modelTurns: 0,
        readyToSend: null,
      },
    });

    expect(card.siteLabel).toBe("Northwind careers");
    expect(card.pageUrl).toBe("https://apply.example.test/form?step=3");
    expect(card.answers).toHaveLength(2);
    // A stored fact and a written one are distinguishable at a glance.
    expect(card.answers[0]).toMatchObject({
      question: "Email",
      source: "your email address",
      sourceId: "profile.email",
      written: false,
    });
    expect(card.answers[1]?.written).toBe(true);
    expect(card.attachments[0]).toMatchObject({
      label: "Your CV",
      field: "Resume/CV",
    });
    expect(card.letter?.text).toContain("I build platforms");
    expect(card.letter?.groundedIn).toContain(
      "the resume sent with this application",
    );
    expect(card.waitingOnYou).toHaveLength(1);
  });

  test("nothing waiting on you means it is ready to send", () => {
    const card = buildApplyReviewCard({
      preparedAt: "2026-09-14T10:05:00.000Z",
      siteLabel: "the careers site",
      result: {
        outcome: "awaiting_your_review",
        reason: "Ready.",
        steps: 4,
        finalUrl: null,
        filled: [],
        attachments: [],
        pauses: [],
        notes: [],
        timeline: [],
        modelTurns: 0,
        readyToSend: null,
      },
    });
    expect(card.waitingOnYou).toHaveLength(0);
    expect(card.letter).toBeNull();
  });
});

describe("each mode, end to end through the seam", () => {
  const ORIGIN = "https://apply.example.test";

  function completableSession(): ApplyPageSession {
    const filled = new Map<string, string>();
    return {
      readPage: () =>
        Promise.resolve({
          url: PAGE_URL,
          title: "Apply",
          bodyText: "Apply for the role",
          controls: [
            {
              index: 0,
              tagName: "input",
              inputType: "email",
              role: "",
              id: "email",
              name: "email",
              label: "Email",
              groupLabel: "",
              placeholder: "",
              autocomplete: "",
              required: true,
              invalid: false,
              validationMessage: "",
              disabled: false,
              readOnly: false,
              visible: true,
              value: filled.get("c0") ?? "",
              checked: false,
              multiple: false,
              options: [],
              selectedOptionLabel: "",
            },
          ],
          actions: [
            {
              index: 0,
              label: "Submit application",
              visible: true,
              disabled: false,
            },
          ],
          links: [],
          headings: [],
          clickables: [],
          openedTabs: [],
          loading: false,
          validationErrors: [],
          stepLabel: null,
        }),
      fillText: (ref, value) => {
        filled.set(ref, value);
        return Promise.resolve({ ok: true, observedValue: value });
      },
      chooseOption: (_ref, option) =>
        Promise.resolve({ ok: true, observedValue: option }),
      setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
      uploadFile: (_ref, file) =>
        Promise.resolve({ ok: true, observedValue: file.name }),
      clickAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      navigate: () => Promise.resolve({ ok: true, url: PAGE_URL }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      pressKey: (_ref, key) =>
        Promise.resolve({ ok: true, observedValue: key }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
      wait: () => Promise.resolve(),
      goBack: () => Promise.resolve({ ok: true, url: PAGE_URL }),
      readText: () => Promise.resolve("Apply for the role"),
      followLink: () => Promise.resolve({ ok: true, url: PAGE_URL }),
      installPrepareOnlyGuard: () => Promise.resolve(),
      readBlockedAttempt: () => Promise.resolve(null),
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => Promise.resolve(),
      closeIntermediateWriteWindow: () => Promise.resolve(),
      closeUploadWindow: () => Promise.resolve(),
      clickAuthorizedFormAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      readIntermediateWriteCount: () => 0,
      checkServiceWorker: () => Promise.resolve(null),
    };
  }

  /** Works the form, then asks to send once nothing is left. */
  function completingModel(): LLMClient {
    let calls = 0;
    return {
      chatWithTools: (_messages, tools) => {
        // The page's questions are classified in their own call (ADR 0041);
        // the email field is neither a pay question nor a declaration.
        if (
          tools?.some((tool) => tool.function.name === "report_question_kinds")
        ) {
          return Promise.resolve({
            toolCalls: [
              {
                id: "call_kinds",
                type: "function" as const,
                function: {
                  name: "report_question_kinds",
                  arguments: JSON.stringify({
                    questions: [
                      { index: 0, asksAboutPay: false, declarationKind: null },
                    ],
                  }),
                },
              },
            ],
          });
        }
        calls += 1;
        // Answer the one field, say the form is complete, then finish.
        const name =
          calls === 1 ? "type" : calls === 2 ? "submit_application" : "finish";
        const args =
          name === "type"
            ? { ref: "c0", text: "robin.ashford@example.test" }
            : name === "submit_application"
              ? { ref: "a0" }
              : { reason: "Nothing left to fill in" };
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${calls}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
      },
    };
  }

  async function runInMode(
    mode: "prepare_only" | "confirm_before_submit" | "autonomous_submit",
    savedWrites = 0,
    pendingSave = false,
  ) {
    const facts = executionInput();
    let handoff: ApplySubmissionHandoff | null = null;
    let intermediateSaved = false;
    const clicks: string[] = [];
    const session = completableSession();
    const watched: ApplyPageSession = {
      ...session,
      readIntermediateWriteCount: () => savedWrites,
      ...(pendingSave
        ? {
            drainIntermediateWrites: async () => {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              savedWrites += 1;
            },
          }
        : {}),
      clickAction: (ref) => {
        clicks.push(ref);
        return session.clickAction(ref);
      },
    };

    await runAgentApplicationPreparation({
      session: watched,
      executionInput: {
        ...facts,
        mode:
          mode === "autonomous_submit" ? "submit_when_ready" : "prepare_only",
        applyAutomationMode: mode,
        submitAuthorized: mode === "autonomous_submit",
        applyAllowedOrigins: [ORIGIN],
      },
      ...(mode === "prepare_only" ? {} : { envelope: envelopeFor(mode) }),
      llmClient: completingModel(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      onPrepared: (outcome) => {
        handoff = outcome.handoff;
        intermediateSaved = outcome.reviewCard.intermediateSaved === true;
      },
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    return {
      handoff: handoff as ApplySubmissionHandoff | null,
      clicks,
      intermediateSaved,
    };
  }

  test("fill-in-only never becomes a send, and presses nothing", async () => {
    const { handoff, clicks } = await runInMode("prepare_only");
    expect(handoff?.status).toBe("not_ready");
    expect(clicks).toHaveLength(0);
  });

  test("confirm-first stops with the send button found and nothing pressed", async () => {
    const { handoff, clicks } = await runInMode("confirm_before_submit");
    expect(handoff?.status).toBe("awaiting_your_review");
    if (handoff?.status === "awaiting_your_review") {
      expect(handoff.finalAction.actionLabel).toBe("Submit application");
    }
    expect(clicks).toHaveLength(0);
  });

  test("strict Fill never discloses step saves, even with a stale legacy count", async () => {
    const result = await runInMode("confirm_before_submit", 3);
    expect(result.handoff?.status).toBe("awaiting_your_review");
    expect(result.intermediateSaved).toBe(false);
    expect(result.clicks).toEqual([]);
    expect((await runInMode("confirm_before_submit")).intermediateSaved).toBe(
      false,
    );
  });

  test("strict Fill ignores a legacy pending save check and never discloses it", async () => {
    const result = await runInMode("confirm_before_submit", 0, true);
    expect(result.handoff?.status).toBe("awaiting_your_review");
    expect(result.intermediateSaved).toBe(false);
    expect(result.clicks).toEqual([]);
  });

  test("sending on its own hands over to the submission path, still pressing nothing here", async () => {
    const { handoff, clicks } = await runInMode("autonomous_submit");
    expect(handoff?.status).toBe("send_now");
    // Preparation never clicks the send button; the submission path does.
    expect(clicks).toHaveLength(0);
  });
});

/**
 * A form with several questions comes back once, with all of them.
 *
 * The record is what the person acts on, so every question the run could not
 * answer has to survive the trip from the loop to the record — choices and
 * all — and a run that throws has to end as something they can see rather
 * than as a record that says it is still going.
 */
describe("questions and failures reaching the record", () => {
  function questionPage(): RawApplyPage {
    return {
      ...rawPage("Apply for the role"),
      controls: [
        {
          index: 0,
          tagName: "select",
          inputType: "select-one",
          role: "",
          id: "q0",
          name: "q0",
          label: "Have you previously worked at or consulted for us?",
          groupLabel: "",
          placeholder: "",
          autocomplete: "",
          required: true,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: true,
          value: "",
          checked: false,
          multiple: false,
          // A list's blank first choice is not an answer anyone could give.
          options: ["", "Yes", "No"],
          selectedOptionLabel: "",
        },
        {
          index: 1,
          tagName: "select",
          inputType: "select-one",
          role: "",
          id: "q1",
          name: "q1",
          label: "What are your salary expectations?",
          groupLabel: "",
          placeholder: "",
          autocomplete: "",
          required: true,
          invalid: false,
          validationMessage: "",
          disabled: false,
          readOnly: false,
          visible: true,
          value: "",
          checked: false,
          multiple: false,
          options: ["", "Up to 50k", "50k to 70k"],
          selectedOptionLabel: "",
        },
      ],
    };
  }

  /** Answers nothing it has no facts for, and says it is done. */
  function modelThatTriesBothThenFinishes(): LLMClient {
    let calls = 0;
    return {
      chatWithTools: () => {
        calls += 1;
        const name = "finish";
        const args = { reason: "Nothing left to fill in" };
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${calls}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
      },
    };
  }

  test("two unanswered questions both become pending question records", async () => {
    const page = questionPage();
    const openSession: ApplyPageSession = {
      ...session(),
      readPage: () => Promise.resolve(page),
    };

    const result = await runAgentApplicationPreparation({
      session: openSession,
      executionInput: executionInput(),
      llmClient: modelThatTriesBothThenFinishes(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.questions).toHaveLength(2);
    expect(result.questions.map((question) => question.prompt)).toEqual([
      "Have you previously worked at or consulted for us?",
      "What are your salary expectations?",
    ]);
    // The choices travel with the question, and the blank one does not.
    expect(result.questions[0]?.answerOptions).toEqual(["Yes", "No"]);
    expect(result.questions[1]?.answerOptions).toEqual([
      "Up to 50k",
      "50k to 70k",
    ]);
    expect(result.blocker?.code).toBe("missing_candidate_answer");
    expect(result.blocker?.questionIds).toHaveLength(2);
    expect(result.summary).toContain("needs your answers to 2 questions");
    expect(result.nextActionLabel).toBe(
      "Answer the form's questions and continue",
    );
  });

  test("a required file is a browser upload step, not a text answer", async () => {
    const page = questionPage();
    page.controls = [
      {
        ...page.controls[0]!,
        tagName: "input",
        inputType: "file",
        label: "Portfolio",
        options: [],
      },
    ];
    const result = await runAgentApplicationPreparation({
      session: {
        ...session(),
        readPage: () => Promise.resolve(page),
      },
      executionInput: executionInput(),
      llmClient: modelThatTriesBothThenFinishes(),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });
    expect(result.questions[0]?.answerControlType).toBe("file");
    expect(result.blocker?.userActionKind).toBe("manual_upload");
  });

  test("a run that throws is recorded as stopped, in words the person can read", async () => {
    const page = questionPage();
    const openSession: ApplyPageSession = {
      ...session(),
      readPage: () => Promise.resolve(page),
    };

    const result = await runAgentApplicationPreparation({
      session: openSession,
      executionInput: executionInput(),
      llmClient: {
        chatWithTools: () =>
          Promise.reject(new Error("the assistant went away mid-form")),
      },
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.state).toBe("failed");
    expect(result.detail).toContain("the careers site");
    expect(result.blocker).not.toBeNull();
  });
});

/**
 * The form the person actually met.
 *
 * Names, a phone split into a country list of 240 entries and a number, a
 * file, a URL, a yes/no question whose label carries the site's required star,
 * lists whose first choice is a placeholder, two controls with the same label,
 * and free text. Every one of these has to survive the trip into the record.
 */
describe("a real application form reaching the record", () => {
  function rawControlOf(
    index: number,
    overrides: Record<string, unknown>,
  ): RawApplyPage["controls"][number] {
    return {
      index,
      tagName: "input",
      inputType: "text",
      role: "",
      id: `f${index}`,
      name: `f${index}`,
      label: "",
      groupLabel: "",
      placeholder: "",
      autocomplete: "",
      required: false,
      invalid: false,
      validationMessage: "",
      disabled: false,
      readOnly: false,
      visible: true,
      value: "",
      checked: false,
      multiple: false,
      options: [],
      selectedOptionLabel: "",
      ...overrides,
    } as RawApplyPage["controls"][number];
  }

  function realisticPage(): RawApplyPage {
    const countries = Array.from({ length: 240 }, (_, index) =>
      index === 0 ? "Select..." : `Country ${index}`,
    );
    return {
      ...rawPage("Apply for this job"),
      controls: [
        rawControlOf(0, { label: "First Name", required: true }),
        rawControlOf(1, { label: "Last Name", required: true }),
        rawControlOf(2, { label: "Email", inputType: "email", required: true }),
        rawControlOf(3, {
          tagName: "select",
          inputType: "select-one",
          label: "Phone",
          groupLabel: "Phone",
          options: countries,
          required: true,
        }),
        rawControlOf(4, {
          label: "Phone",
          groupLabel: "Phone",
          required: true,
        }),
        rawControlOf(5, {
          inputType: "file",
          label: "Resume/CV",
          required: true,
        }),
        rawControlOf(6, { label: "LinkedIn Profile", inputType: "url" }),
        rawControlOf(7, {
          tagName: "select",
          inputType: "select-one",
          label: "Have you previously worked at or consulted for GitLab?*",
          options: ["Select...", "Yes", "No"],
          required: true,
        }),
        rawControlOf(8, {
          tagName: "select",
          inputType: "select-one",
          label: "Gender",
          groupLabel: "U.S. Equal Employment Opportunity information",
          options: ["Select...", "Male", "Female", "Decline To Self Identify"],
        }),
        rawControlOf(9, {
          tagName: "select",
          inputType: "select-one",
          label: "Gender",
          groupLabel: "Voluntary Self-Identification",
          options: ["Select...", "Male", "Female", " "],
        }),
        rawControlOf(10, {
          tagName: "textarea",
          inputType: "textarea",
          label: "Why do you want to work here?",
        }),
      ],
      actions: [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
    };
  }

  /** Works every control in turn, then finishes: what the model really does. */
  function modelThatWorksEveryControl(count: number): LLMClient {
    let calls = 0;
    return {
      chatWithTools: () => {
        const name = calls < count ? "answer_control" : "finish";
        const args =
          calls < count
            ? { ref: `c${calls}`, freeTextAnswer: "Because the work matters." }
            : { reason: "Nothing left to fill in" };
        calls += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${calls}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
      },
    };
  }

  test("every question survives the trip into the record", async () => {
    const page = realisticPage();
    const openSession: ApplyPageSession = {
      ...session(),
      readPage: () => Promise.resolve(page),
    };

    const result = await runAgentApplicationPreparation({
      session: openSession,
      executionInput: executionInput(),
      llmClient: modelThatWorksEveryControl(11),
      startedAt: "2026-09-14T10:00:00.000Z",
      siteLabel: "the careers site",
      now: () => new Date("2026-09-14T10:05:00.000Z"),
    });

    expect(result.state).toBe("paused");
    expect(result.questions.length).toBeGreaterThan(0);
    for (const question of result.questions) {
      expect(question.prompt.trim().length).toBeGreaterThan(0);
      expect(question.id.trim().length).toBeGreaterThan(0);
      for (const option of question.answerOptions) {
        expect(option.trim().length).toBeGreaterThan(0);
      }
    }
    // Two controls sharing a label must not produce two records with one id.
    const ids = result.questions.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("toApplyDocuments", () => {
  test("keeps the kind of the person's own files so a saved cover letter counts as available", () => {
    const documents = toApplyDocuments({
      resumeArtifact: {
        id: "resume_1",
        fileName: "jamie-rivers.pdf",
        filePath: "/tmp/jamie-rivers.pdf",
        sha256: "a".repeat(64),
      },
      applicationAttachments: [
        {
          assetId: "asset_letter",
          questionId: null,
          prompt: "Cover letter from the person's files",
          questionKind: "cover_letter",
          fileName: "letter.pdf",
          mime: "application/pdf",
          sha256: "b".repeat(64),
          loadVerifiedBytes: () => Promise.resolve(new Uint8Array()),
        },
        {
          assetId: "asset_portfolio",
          questionId: null,
          prompt: "Portfolio from the person's files",
          questionKind: "portfolio",
          fileName: "portfolio.pdf",
          mime: "application/pdf",
          sha256: "c".repeat(64),
          loadVerifiedBytes: () => Promise.resolve(new Uint8Array()),
        },
      ],
    } as unknown as Parameters<typeof toApplyDocuments>[0]);

    expect(documents.map((document) => [document.id, document.kind])).toEqual([
      ["document_resume_resume_1", "resume"],
      ["document_asset_asset_letter", "cover_letter"],
      ["document_asset_asset_portfolio", "portfolio"],
    ]);
  });
});

test("a handback adds answers while retaining contacts, generated text and exact attachments", () => {
  const card = buildApplyReviewCard({
    siteLabel: "Synthetic employer",
    preparedAt: "2026-09-14T10:05:00.000Z",
    result: {
      outcome: "prepared",
      reason: "Ready.",
      steps: 1,
      finalUrl: null,
      filled: [],
      attachments: [],
      pauses: [],
      notes: [],
      timeline: [],
      modelTurns: 0,
      readyToSend: null,
    },
  });
  const contact = {
    question: "Email",
    answer: "robin@example.test",
    source: "your email address",
    written: false,
    groundedIn: [],
  };
  const written = {
    question: "Why this job?",
    answer: "I build dependable platforms.",
    source: "this application",
    written: true,
    groundedIn: ["your profile"],
  };
  const previous = {
    ...card,
    answers: [contact, written],
    attachments: [
      { label: "Your CV", field: "Resume", fileName: "original.docx" },
    ],
    waitingOnYou: ["Authorization"],
  };
  const current = {
    ...card,
    answers: [
      {
        question: "Authorization",
        answer: "No",
        source: "your answer to this question",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [
      { label: "Your CV", field: "Resume", fileName: "approved.pdf" },
    ],
  };
  const merged = mergeApplyReviewCards(previous, current);
  expect(merged?.answers).toEqual([contact, written, current.answers[0]]);
  expect(merged?.attachments).toEqual(current.attachments);
  expect(merged?.waitingOnYou).toEqual([]);
});

test("continued observations preserve generated provenance and distinct equal-worded fields", () => {
  const base = buildApplyReviewCard({
    siteLabel: "Synthetic employer",
    preparedAt: "2026-09-14T10:05:00.000Z",
    result: {
      outcome: "prepared",
      reason: "Ready.",
      steps: 1,
      finalUrl: null,
      filled: [],
      attachments: [],
      pauses: [],
      notes: [],
      timeline: [],
      modelTurns: 0,
      readyToSend: null,
    },
  });
  const previous = {
    ...base,
    answers: [
      {
        fieldKey: "https://example.test/form|Work|c0|Description",
        question: "Description",
        answer: "First role.",
        written: true,
        source: "this application",
        groundedIn: ["your profile"],
      },
      {
        fieldKey: "https://example.test/form|Work|c1|Description",
        question: "Description",
        answer: "Second role.",
        written: true,
        source: "this application",
        groundedIn: ["your profile"],
      },
    ],
  };
  const current = {
    ...base,
    answers: [
      previous.answers[0]!,
      {
        ...previous.answers[1]!,
        written: false,
        source: "the filled application form",
      },
    ],
  };
  expect(mergeApplyReviewCards(previous, current)?.answers).toEqual(
    previous.answers,
  );
});

test("a form stopped on an early step cannot become a ready application record", async () => {
  const page = rawPage("Application");
  page.stepLabel = "Step 2 of 4";
  page.actions = [{ index: 0, label: "Next", visible: true, disabled: false }];
  const result = await runAgentApplicationPreparation({
    session: { ...session(), readPage: () => Promise.resolve(page) },
    executionInput: executionInput(),
    llmClient: modelThatFinishes(),
    startedAt: "2026-09-14T10:00:00.000Z",
    siteLabel: "the careers site",
  });
  expect(result.state).toBe("paused");
  expect(result.blocker).toMatchObject({
    code: "requires_manual_review",
    userActionKind: "other",
  });
  expect(result.detail).toContain("another step");
});

test("a required cover letter with Never is a named file handoff", async () => {
  const page = rawPage("Application");
  page.controls = [
    {
      ...page.controls[0]!,
      inputType: "file",
      label: "Cover letter",
      required: true,
      value: "",
    },
  ];
  const input = executionInput();
  input.settings.aiBehavior = AiBehaviorPreferenceSchema.parse({
    applying: { coverLetterPolicy: "never" },
  });
  const result = await runAgentApplicationPreparation({
    session: { ...session(), readPage: () => Promise.resolve(page) },
    executionInput: input,
    llmClient: modelThatFinishes(),
    startedAt: "2026-09-14T10:00:00.000Z",
    siteLabel: "the careers site",
  });
  expect(result.state).toBe("paused");
  expect(result.questions[0]).toMatchObject({
    prompt: "Cover letter",
    answerControlType: "file",
  });
  expect(result.blocker?.userActionKind).toBe("manual_upload");
  expect(result.detail).toContain("settings");
  expect(result.nextActionLabel).toBe("Add the required cover letter");
});

test("a required cover letter and text questions share an answerable handoff", async () => {
  const page = rawPage("Application");
  page.controls = [
    {
      ...page.controls[0]!,
      inputType: "file",
      label: "Cover letter",
      required: true,
      value: "",
    },
  ];
  page.controls.push({
    ...page.controls[0]!,
    index: 1,
    inputType: "text",
    label: "Portfolio URL",
    required: true,
    value: "",
  });
  const input = executionInput();
  input.settings.aiBehavior = AiBehaviorPreferenceSchema.parse({
    applying: { coverLetterPolicy: "never" },
  });
  const result = await runAgentApplicationPreparation({
    session: { ...session(), readPage: () => Promise.resolve(page) },
    executionInput: input,
    llmClient: modelThatFinishes(),
    startedAt: "2026-09-14T10:00:00.000Z",
    siteLabel: "the careers site",
  });
  expect(result.state).toBe("paused");
  expect(result.questions[0]).toMatchObject({
    prompt: "Cover letter",
    answerControlType: "file",
  });
  expect(result.blocker?.userActionKind).toBeNull();
  expect(result.questions.map((question) => question.prompt)).toContain(
    "Portfolio URL",
  );
  expect(result.detail).toContain("settings");
  expect(result.nextActionLabel).toBe(
    "Add the required files and answer the remaining questions",
  );
});

test("a refreshed review drops an answer and attachment cleared on the live form", () => {
  const previous = ApplicationReviewCardSchema.parse({
    siteLabel: "Synthetic form",
    preparedAt: "2026-10-04T10:00:00.000Z",
    answers: [
      {
        fieldKey: "motivation",
        question: "Motivation",
        answer: "Old answer",
        source: "the filled application form",
        written: false,
        groundedIn: [],
      },
    ],
    attachments: [
      {
        fieldKey: "portfolio",
        label: "Portfolio",
        fileName: "old.pdf",
        field: "Portfolio",
      },
    ],
  });
  const current = ApplicationReviewCardSchema.parse({
    siteLabel: "Synthetic form",
    preparedAt: "2026-10-04T11:00:00.000Z",
    answers: [],
    attachments: [],
    observedFieldKeys: ["motivation", "portfolio"],
  });
  const merged = mergeApplyReviewCards(previous, current);
  expect(merged?.answers).toEqual([]);
  expect(merged?.attachments).toEqual([]);
});

test("send review collapses identical answers and attachments from repeated form steps", () => {
  const answer = {
    question: "Email",
    answer: "synthetic@example.test",
    source: "your email address",
    written: false,
    groundedIn: [],
  };
  const attachment = {
    label: "Your CV",
    field: "Resume",
    fileName: "synthetic.pdf",
  };
  const card = {
    siteLabel: "Synthetic",
    pageUrl: null,
    answers: [answer],
    attachments: [attachment],
    letter: null,
    waitingOnYou: [],
    preparedAt: "2026-10-04T00:00:00.000Z",
  };
  const prior = {
    ...card,
    answers: ["1", "2", "3"].map((step) => ({
      ...answer,
      fieldKey: `${step}|email`,
    })),
    attachments: ["1", "2", "3"].map((step) => ({
      ...attachment,
      fieldKey: `${step}|resume`,
    })),
  };
  const merged = mergeApplyReviewCards(prior, {
    ...card,
    answers: [{ ...answer, fieldKey: "4|email" }],
    attachments: [{ ...attachment, fieldKey: "4|resume" }],
  });
  expect(merged?.answers).toHaveLength(1);
  expect(merged?.attachments).toHaveLength(1);
});

test("a paused unchecked letter stays on the review card without an attachment", () => {
  const card = buildApplyReviewCard({
    siteLabel: "Synthetic",
    preparedAt: "2026-10-04T12:00:00.000Z",
    result: {
      outcome: "paused",
      reason: "Review the letter",
      steps: 1,
      finalUrl: null,
      filled: [],
      attachments: [],
      notes: [],
      timeline: [],
      modelTurns: 1,
      readyToSend: null,
      pauses: [
        {
          code: "document_needs_you",
          summary: "Agree how to handle the location mismatch.",
          question: null,
          blocker: null,
          reviewDraft: {
            text: "Letter awaiting your review.",
            groundedIn: ["Resume"],
            reason: "Agree how to handle the location mismatch.",
          },
        },
      ],
    },
  });
  expect(card.letter?.text).toBe("Letter awaiting your review.");
  expect(card.letter?.reviewReason).toContain("location mismatch");
  expect(card.attachments).toEqual([]);
  expect(card.waitingOnYou).toContain(
    "Agree how to handle the location mismatch.",
  );
});

test("preparation honors an eligibility answer saved on an earlier attempt of this application", async () => {
  const facts = executionInput();
  facts.job.location = "United Kingdom";
  facts.applicationPageBindingKey = "new_result";
  const rememberedAnswers = [
    {
      id: "own_answer",
      kind: "work_authorization" as const,
      label: "Are you authorized to work here?",
      question: "Are you authorized to work here?",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
      applicationScope: {
        resultId: "old_result",
        applicationRecordId: "same_application",
        location: "United Kingdom",
      },
    },
  ];
  const page = rawPage("Application");
  page.controls = [
    {
      ...page.controls[0]!,
      tagName: "select",
      inputType: "",
      label: "Are you authorized to work here?",
      options: ["Yes", "No"],
      required: true,
    },
  ];
  const chooseOption = vi.fn<ApplyPageSession["chooseOption"]>(
    (_ref, option) => {
      page.controls[0]!.value = option;
      page.controls[0]!.selectedOptionLabel = option;
      return Promise.resolve({ ok: true, observedValue: option });
    },
  );
  let calls = 0;
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(
    (_messages, tools) => {
      if (tools[0]?.function.name === "report_question_kinds") {
        return Promise.resolve({
          toolCalls: [
            {
              id: "classification",
              type: "function",
              function: {
                name: "report_question_kinds",
                arguments: JSON.stringify({
                  questions: [
                    {
                      index: 0,
                      eligibilityKind: "work_authorization",
                      asksAboutPay: false,
                      asksCurrentPay: false,
                      required: true,
                      declarationKind: null,
                    },
                  ],
                }),
              },
            },
          ],
        });
      }
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function",
            function: {
              name: calls === 1 ? "select" : "finish",
              arguments: JSON.stringify(
                calls === 1
                  ? { ref: "c0", option: "Yes" }
                  : { reason: "The application is complete" },
              ),
            },
          },
        ],
      });
    },
  );
  const prepare = createApplyFormPreparer({
    executionInput: facts,
    applicationRecordId: "same_application",
    readReusableAnswers: () => Promise.resolve(rememberedAnswers),
    aiClient: { chatWithTools },
    siteLabel: "the careers site",
  });
  const result = await prepare({
    session: {
      ...session(),
      readPage: () => Promise.resolve(page),
      chooseOption,
    },
    currentUrl: PAGE_URL,
    startedAt: "2026-09-14T10:00:00.000Z",
  });
  expect(chooseOption).toHaveBeenCalledWith("c0", "Yes");
  expect(result.questions).toEqual([]);
  expect(result.state).toBe("ready");
  expect(calls).toBe(2);
  expect(
    chatWithTools.mock.calls.some(
      ([, tools]) => tools[0]?.function.name === "report_answer_checks",
    ),
  ).toBe(false);
});

test("a failed provider call still returns typed timing for persistence", async () => {
  const result = await runAgentApplicationPreparation({
    session: session(),
    executionInput: executionInput(),
    llmClient: {
      chatWithTools: () => {
        return Promise.reject(new Error("Synthetic outage"));
      },
    },
    startedAt: "2026-09-14T10:00:00.000Z",
    siteLabel: "the careers site",
    now: () => new Date("2026-09-14T10:05:00.000Z"),
  });
  expect(result.state).toBe("failed");
  expect(result.agentTiming).toMatchObject({ modelTurns: 1, pageReads: 1 });
});

test("review keeps the latest value across handles and removes cleared fields", () => {
  const previous = ApplicationReviewCardSchema.parse({
    siteLabel: "Synthetic board",
    pageUrl: PAGE_URL,
    preparedAt: "2026-10-01T10:00:00.000Z",
    answers: [
      {
        fieldKey: `${PAGE_URL}|Contact|c0|Email`,
        question: "Email",
        answer: "old@example.test",
        written: false,
        source: "your email",
      },
    ],
    attachments: [
      {
        fieldKey: `${PAGE_URL}|Contact|c1|Resume`,
        label: "CV",
        field: "Resume",
        fileName: "old.pdf",
      },
    ],
  });
  const current = ApplicationReviewCardSchema.parse({
    ...previous,
    answers: [
      {
        ...previous.answers[0],
        fieldKey: `${PAGE_URL}|Contact|c9|Email`,
        answer: "new@example.test",
      },
    ],
    attachments: [
      {
        ...previous.attachments[0],
        fieldKey: `${PAGE_URL}|Contact|c8|Resume`,
        fileName: "new.pdf",
      },
    ],
  });
  const merged = mergeApplyReviewCards(previous, current)!;
  expect(merged.answers.map((entry) => entry.answer)).toEqual([
    "new@example.test",
  ]);
  expect(merged.attachments.map((entry) => entry.fileName)).toEqual([
    "new.pdf",
  ]);
  expect(
    mergeApplyReviewCards(merged, {
      ...current,
      answers: [],
      attachments: [],
      observedFieldKeys: [
        `${PAGE_URL}|Contact|c20|Email`,
        `${PAGE_URL}|Contact|c21|Resume`,
      ],
    }),
  ).toMatchObject({ answers: [], attachments: [] });
});

test.each(["file", "text"] as const)(
  "Prepare again reads the latest approved library letter and uses it as %s unchanged",
  async (delivery) => {
    const page = rawPage("Application");
    page.controls = [
      {
        ...page.controls[0]!,
        inputType: delivery === "file" ? "file" : "text",
        label: "Cover letter",
        required: true,
        value: "",
      },
    ];
    const currentSession = {
      ...session(),
      readPage: () => Promise.resolve(page),
    };
    const fill = vi.fn((_ref: string, value: string) => {
      page.controls[0]!.value = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const upload = vi.fn(
      (_ref: string, file: { name: string; bytes: Uint8Array }) => {
        page.controls[0]!.value = file.name;
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      },
    );
    currentSession.fillText = fill;
    currentSession.uploadFile = upload;
    const installGuard = vi.spyOn(currentSession, "installPrepareOnlyGuard");
    const facts = executionInput();
    facts.intermediateMutationsAuthorized = true;
    facts.intermediateMutationAllowedOrigins = [];
    facts.applyAllowedOrigins = [new URL(PAGE_URL).origin];
    const recheck = vi.fn(() => Promise.resolve(true));
    facts.recheckIntermediateMutationAuthority = recheck;
    const approved = "  My exact approved revision two.\n";
    const writeLetter = vi.fn();
    const getApprovedText = vi.fn(() => Promise.resolve(approved));
    let turn = 0;
    const llmClient: LLMClient = {
      chatWithTools: (_messages, tools) => {
        const classification =
          tools[0]?.function.name === "report_question_kinds";
        const tool = classification
          ? "report_question_kinds"
          : ++turn === 1
            ? "fill_fields"
            : "finish";
        const args = classification
          ? {
              questions: [
                { index: 0, asksAboutPay: false, declarationKind: null },
              ],
            }
          : tool === "fill_fields"
            ? {
                fields: [
                  delivery === "file"
                    ? { tool: "upload", ref: "c0", documentId: "letter" }
                    : { tool: "type", ref: "c0", text: "Model rewrite" },
                ],
              }
            : { reason: "Send application not pressed per fill-only mode" };
        return Promise.resolve({
          toolCalls: [
            {
              id: `call-${turn}`,
              type: "function",
              function: { name: tool, arguments: JSON.stringify(args) },
            },
          ],
        });
      },
    };
    const prepared = vi.fn();
    const result = await runAgentApplicationPreparation({
      session: currentSession,
      executionInput: facts,
      applicationRecordId: "application",
      startedAt: "2026-10-06T10:00:00.000Z",
      siteLabel: "Synthetic careers",
      llmClient,
      onPrepared: prepared,
      letters: {
        preference: {
          tone: "direct",
          length: "short",
          language: null,
          sample: null,
        },
        getApprovedText,
        writeLetter,
        renderLetter: ({ text }) =>
          Promise.resolve({
            ok: true,
            fileName: "approved.txt",
            mimeType: "text/plain",
            loadBytes: () => Promise.resolve(new TextEncoder().encode(text)),
          }),
      },
    });
    expect(result.state).toBe("ready");
    expect(recheck).toHaveBeenCalledWith(
      new URL(PAGE_URL).origin,
      delivery === "file" ? "attachment" : "answers",
    );
    expect(installGuard.mock.calls.length).toBeGreaterThan(1);
    for (const [guard] of installGuard.mock.calls)
      expect(guard).toEqual({
        intermediateMutationsAuthorized: true,
        allowedOrigins: [],
      });
    expect(getApprovedText).toHaveBeenCalledWith(
      executionInput().job.id,
      "application",
    );
    expect(writeLetter).not.toHaveBeenCalled();
    const preparedInput = prepared.mock.calls[0]![0] as {
      reviewCard: { letter: { text: string } };
    };
    expect(preparedInput.reviewCard.letter.text).toBe(approved);
    expect(result.summary).not.toContain("fill-only");
    if (delivery === "file")
      expect(new TextDecoder().decode(upload.mock.calls[0]![1].bytes)).toBe(
        approved,
      );
    else expect(fill).toHaveBeenCalledWith("c0", approved);
  },
);

test("fresh preparations keep unchanged sources without reviving removed answers", () => {
  const labels = [
    "Full name",
    "Email",
    "Phone",
    "Portfolio URL",
    "Why this role?",
  ];
  const sources = [
    "your name",
    "your email address",
    "your phone number",
    "your portfolio",
    "your answer to this question",
  ];
  const values = [
    "Alex Example",
    "alex@example.test",
    "+44123456789",
    "https://example.test/portfolio",
    "I build dependable platforms.",
  ];
  const previous = ApplicationReviewCardSchema.parse({
    siteLabel: "Example",
    pageUrl: PAGE_URL,
    preparedAt: "2026-10-06T10:00:00.000Z",
    answers: labels.map((question, i) => ({
      question,
      fieldKey: `${PAGE_URL}|Application|c${i}|${question}`,
      answer: values[i],
      source: sources[i],
      written: false,
    })),
  });
  let current = ApplicationReviewCardSchema.parse({
    ...previous,
    preparedAt: "2026-10-06T10:01:00.000Z",
    answers: previous.answers.map((answer, i) => ({
      ...answer,
      fieldKey: `${PAGE_URL}|Application|c${i + 10}|${answer.question}`,
      source: "the filled application form",
    })),
  });
  for (let run = 0; run < 3; run += 1) {
    current = mergeApplyReviewCards(
      run === 0 ? previous : current,
      {
        ...current,
        answers: current.answers.map((answer) => ({
          ...answer,
          source: "the filled application form",
        })),
      },
      { freshPreparation: true },
    )!;
    expect(current.answers.map((answer) => answer.source)).toEqual(sources);
  }
  const changed = mergeApplyReviewCards(
    current,
    {
      ...current,
      answers: current.answers.slice(0, 4).map((answer, i) => ({
        ...answer,
        answer: i === 1 ? "changed@example.test" : answer.answer,
        source: "the filled application form",
      })),
    },
    { freshPreparation: true },
  )!;
  expect(changed.answers).toHaveLength(4);
  expect(changed.answers[1]?.source).toBe("the filled application form");
  expect(
    changed.answers.some((answer) => answer.question === "Why this role?"),
  ).toBe(false);
  expect(
    mergeApplyReviewCards(previous, null, { freshPreparation: true }),
  ).toBeNull();
});

test("preparing again keeps the letter that is still on the form", () => {
  const letter = {
    text: "Dear team, I would like to apply.",
    fields: ["Cover letter"],
    groundedIn: ["your approved letter"],
  };
  const attachment = {
    field: "Cover letter",
    fileName: "alex-example-cover-letter.pdf",
    label: "Cover letter you approved",
  };
  const previous = ApplicationReviewCardSchema.parse({
    siteLabel: "Example",
    pageUrl: PAGE_URL,
    preparedAt: "2026-10-06T10:00:00.000Z",
    attachments: [attachment],
    letter,
  });
  // The re-run found the file already attached and filled nothing.
  const rerun = ApplicationReviewCardSchema.parse({
    ...previous,
    preparedAt: "2026-10-06T10:01:00.000Z",
    letter: null,
  });
  expect(
    mergeApplyReviewCards(previous, rerun, { freshPreparation: true })?.letter,
  ).toEqual(letter);
  // A different file in that field is not the earlier letter.
  expect(
    mergeApplyReviewCards(
      previous,
      { ...rerun, attachments: [{ ...attachment, fileName: "other.pdf" }] },
      { freshPreparation: true },
    )?.letter,
  ).toBeNull();
  // The same letter typed into a text field counts too.
  expect(
    mergeApplyReviewCards(
      previous,
      {
        ...rerun,
        attachments: [],
        answers: [
          {
            question: "Cover letter",
            answer: letter.text,
            source: "the filled application form",
            written: false,
            groundedIn: [],
          },
        ],
      },
      { freshPreparation: true },
    )?.letter,
  ).toEqual(letter);
});

test.each([false, true])(
  "a saved declaration reaches the card with the correct evidence (Settings on: %s)",
  async (settingOn) => {
    const facts = executionInput();
    const prompt = "I consent to a background check";
    facts.settings.aiBehavior = AiBehaviorPreferenceSchema.parse({
      applying: {
        preApprovedDeclarations: settingOn ? ["background_check_consent"] : [],
      },
    });
    const rememberedAnswers = [
      {
        id: "saved_declaration",
        kind: "other" as const,
        label: prompt,
        question: prompt,
        answer: "Yes",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const page = rawPage("Application");
    page.controls[0] = {
      ...page.controls[0]!,
      inputType: "checkbox",
      label: prompt,
      id: "declaration",
      name: "declaration",
    };
    let turns = 0;
    let card: ReturnType<typeof buildApplyReviewCard> | null = null;
    const result = await runAgentApplicationPreparation({
      executionInput: facts,
      readReusableAnswers: () => Promise.resolve(rememberedAnswers),
      siteLabel: "Example",
      startedAt: "2026-10-06T10:00:00.000Z",
      session: {
        ...session(),
        readPage: () => Promise.resolve(page),
        setToggle: (_ref, checked) => {
          page.controls[0]!.checked = checked;
          return Promise.resolve({
            ok: true,
            observedValue: checked ? "Yes" : "No",
          });
        },
      },
      onPrepared: (prepared) => {
        card = prepared.reviewCard;
      },
      llmClient: {
        chatWithTools: (_messages, tools) => {
          const classification =
            tools[0]?.function.name === "report_question_kinds";
          const name = classification
            ? "report_question_kinds"
            : ++turns === 1
              ? "set_checkbox"
              : "finish";
          const args = classification
            ? {
                questions: [
                  {
                    index: 0,
                    asksAboutPay: false,
                    declarationKind: "background_check_consent",
                  },
                ],
              }
            : turns === 1
              ? { ref: "c0", checked: true }
              : { reason: "Done." };
          return Promise.resolve({
            toolCalls: [
              {
                id: name,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
        },
      },
    });
    expect(result.state).toBe("ready");
    expect(card).toMatchObject({
      answers: [
        expect.objectContaining({
          answer: "Yes",
          source: "your matching saved answer or profile fact",
          sourceId: "answerLibrary.saved_declaration",
        }),
      ],
    });
  },
);

test("every model call of one person's applications shares one conversation", async () => {
  const chatWithTools = vi.fn(() => Promise.resolve({ content: "ok" }));
  const client = toApplyLlmClient(
    { chatWithTools },
    applyingConversationKey({ id: "candidate_1" }),
  )!;
  await client.chatWithTools([], [], { reasoningTask: "claim_check" });
  expect(chatWithTools).toHaveBeenCalledWith([], [], {
    reasoningTask: "claim_check",
    conversationKey: "applying:candidate_1",
  });
  expect(applyingConversationKey({ id: "candidate_2" })).not.toBe(
    applyingConversationKey({ id: "candidate_1" }),
  );
});
