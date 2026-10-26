import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
} from "@nestor/contracts";
import { createDocumentTestSeed } from "../../adapters/document-test-seed.test-support";
import { CandidateAssetLibrary } from "./candidate-asset-library";
import { ApplicationDocumentLibrary } from "./application-document-library";

describe("ApplicationDocumentLibrary", () => {
  let temporaryDirectory: string;
  let library: ApplicationDocumentLibrary;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-application-documents-"),
    );
    library = new ApplicationDocumentLibrary(
      path.join(temporaryDirectory, "documents"),
      new CandidateAssetLibrary(path.join(temporaryDirectory, "assets")),
      () => new Date("2026-08-10T10:00:00.000Z"),
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function createGrounding() {
    const state = createDocumentTestSeed();
    const job = state.savedJobs.find((entry) => entry.id === "job_ready");
    if (!job) throw new Error("Demo job is missing");
    const applicationRecord = ApplicationRecordSchema.parse({
      id: "application_1",
      jobId: job.id,
      title: job.title,
      company: job.company,
      status: "drafting",
      lastActionLabel: "Prepared application",
      nextActionLabel: "Review",
      lastUpdatedAt: "2026-08-10T09:00:00.000Z",
    });
    const question = ApplicationQuestionRecordSchema.parse({
      id: "question_cover_letter",
      runId: "run_1",
      jobId: job.id,
      resultId: "result_1",
      prompt: "Attach a cover letter",
      kind: "cover_letter",
      answerControlType: "file",
      detectedAt: "2026-08-10T09:00:00.000Z",
    });
    return { profile: state.profile, job, applicationRecord, question };
  }

  it("selects the latest approved letter for this application, including after a new proposal", async () => {
    const grounding = createGrounding();
    const proposed = await library.propose({
      kind: "cover_letter",
      grounding,
      writtenContent: "The earlier letter.",
    });
    const edited = await library.edit(
      proposed.id,
      proposed.revision,
      "  My exact approved letter.\n",
    );
    const approved = await library.approve(edited.id, edited.revision);
    const newDraft = await library.propose({
      kind: "cover_letter",
      grounding,
      documentId: approved.id,
      expectedRevision: approved.revision,
      writtenContent: "Not approved.",
    });
    expect(
      await library.list({
        jobId: grounding.job.id,
        applicationRecordId: grounding.applicationRecord.id,
      }),
    ).toMatchObject({ documents: [newDraft], approvedRevisions: [approved] });
    expect(
      (
        await library.list({
          jobId: "another-job",
          applicationRecordId: grounding.applicationRecord.id,
        })
      ).approvedRevisions,
    ).toEqual([]);
    expect(
      (
        await library.list({
          jobId: grounding.job.id,
          applicationRecordId: "another-application",
        })
      ).approvedRevisions,
    ).toEqual([]);
    expect(
      await library.getLatestApprovedCoverLetter(
        grounding.job.id,
        grounding.applicationRecord.id,
      ),
    ).toMatchObject({ revision: 2, content: approved.content });
    expect(
      await library.getLatestApprovedCoverLetter(
        "another-job",
        grounding.applicationRecord.id,
      ),
    ).toBeNull();
  });

  it("proposes only profile-backed text with exact job and question lineage", async () => {
    const base = createGrounding();
    const grounding = {
      ...base,
      job: {
        ...base.job,
        description: "Build reliable Kubernetes platform services.",
        keySkills: ["Kubernetes"],
      },
      profile: {
        ...base.profile,
        experiences: [
          {
            ...base.profile.experiences[0]!,
            id: "experience_relevant",
            summary: "Built reliable Kubernetes platform services.",
            achievements: [],
          },
          {
            ...base.profile.experiences[0]!,
            id: "experience_irrelevant",
            summary: "Organized regional catering events.",
            achievements: [],
          },
        ],
      },
    };
    const proposed = await library.propose({
      kind: "cover_letter",
      grounding,
    });

    expect(proposed.status).toBe("proposed");
    expect(proposed.question?.questionId).toBe("question_cover_letter");
    expect(proposed.job.jobId).toBe("job_ready");
    expect(proposed.evidence.length).toBeGreaterThan(0);
    expect(proposed.evidence).toHaveLength(3);
    expect(proposed.content).toContain(
      "I built reliable Kubernetes platform services.",
    );
    expect(proposed.content).not.toContain(
      "Organized regional catering events.",
    );
    expect(proposed.content.split(/\s+/).length).toBeLessThan(350);
    expect(new Set(proposed.evidence.map((entry) => entry.text)).size).toBe(
      proposed.evidence.length,
    );
    expect(proposed.content).not.toMatch(/submit|account creation/i);
  });

  it("composes concise first-person prose without repeating overlapping evidence", async () => {
    const base = createGrounding();
    const proposed = await library.propose({
      kind: "cover_letter",
      grounding: {
        ...base,
        profile: {
          ...base.profile,
          professionalSummary: {
            ...base.profile.professionalSummary,
            fullSummary:
              "Builds resilient workflows for design systems, workflow automation, and operations platforms.",
          },
          experiences: [
            {
              ...base.profile.experiences[0]!,
              summary: "Builds resilient workflow tools.",
              achievements: [
                "Led design-system rollout across core workflow surfaces.",
              ],
            },
          ],
          proofBank: [
            {
              ...base.profile.proofBank[0]!,
              claim:
                "Led a design-system rollout across core workflow surfaces used by design and operations teams.",
              heroMetric:
                "Adoption reached 80% of core product surfaces within two quarters.",
              supportingContext:
                "Worked across product, engineering, and operations to standardize interaction and content patterns.",
            },
          ],
        },
      },
    });

    expect(proposed.content).toContain(
      "I build resilient workflows for design systems, workflow automation, and operations platforms.",
    );
    expect(proposed.content).toContain(
      "I led a design-system rollout across core workflow surfaces used by design and operations teams.",
    );
    expect(proposed.content).not.toContain("Builds resilient workflow tools.");
    expect(proposed.content).not.toContain(
      "Led design-system rollout across core workflow surfaces.",
    );
    expect(proposed.content.match(/design-system rollout/gi)).toHaveLength(1);
    expect(proposed.evidence).toHaveLength(3);
    expect(proposed.requiresGroundingReview).toBe(false);
  });

  it("uses the same grounded first-person composition for short responses", async () => {
    const base = createGrounding();
    const proposed = await library.propose({
      kind: "short_response",
      grounding: {
        ...base,
        profile: {
          ...base.profile,
          professionalSummary: {
            ...base.profile.professionalSummary,
            fullSummary: "Builds reliable Kubernetes platform services.",
          },
          experiences: [
            {
              ...base.profile.experiences[0]!,
              summary: "Built reliable Kubernetes platform services.",
              achievements: [],
            },
          ],
        },
      },
    });

    expect(proposed.content).toMatch(
      /^I build reliable Kubernetes platform services\./,
    );
    expect(
      proposed.content.match(/Kubernetes platform services/gi),
    ).toHaveLength(1);
    expect(
      proposed.content.split(/[.!?]+/).filter(Boolean).length,
    ).toBeLessThanOrEqual(3);
    expect(proposed.content).not.toMatch(/Dear Hiring Team|Thank you/i);
    expect(proposed.evidence.length).toBeGreaterThan(0);
  });

  it("retains revision history and rejects stale approvals", async () => {
    const grounding = createGrounding();
    const first = await library.propose({ kind: "short_response", grounding });
    const second = await library.propose({
      kind: "short_response",
      documentId: first.id,
      expectedRevision: first.revision,
      grounding,
    });

    expect(second.revision).toBe(2);
    await expect(library.approve(first.id, first.revision)).rejects.toThrow(
      /changed after it was opened/i,
    );
    const listed = await library.list({
      jobId: grounding.job.id,
      applicationRecordId: grounding.applicationRecord.id,
    });
    expect(listed.documents).toEqual([second]);
  });

  it("stores a user edit as a new review-required CAS revision", async () => {
    const grounding = createGrounding();
    const proposed = await library.propose({ kind: "cover_letter", grounding });
    const edited = await library.edit(
      proposed.id,
      proposed.revision,
      "User-authored cover letter text.",
    );

    expect(edited).toMatchObject({
      revision: 2,
      content: "User-authored cover letter text.",
      authorship: "user_edited",
      requiresGroundingReview: true,
      status: "proposed",
    });
    expect(edited.evidence).toEqual(proposed.evidence);
    await expect(
      library.edit(proposed.id, proposed.revision, "Stale edit"),
    ).rejects.toThrow(/changed after it was opened/i);
  });

  it("approves an exact revision into the candidate asset library without retaining temp files", async () => {
    const grounding = createGrounding();
    const proposed = await library.propose({
      kind: "cover_letter",
      grounding,
    });
    const approved = await library.approve(proposed.id, proposed.revision);

    expect(approved.status).toBe("approved");
    expect(approved.outputAsset).toMatchObject({
      kind: "cover_letter",
      consentScope: "job_application_attachment",
      sensitivity: "sensitive",
    });
    const indexText = await readFile(
      path.join(temporaryDirectory, "documents", "index.json"),
      "utf8",
    );
    expect(indexText).not.toContain(temporaryDirectory);
  });

  it("classifies approved short responses as application responses", async () => {
    const grounding = createGrounding();
    const proposed = await library.propose({
      kind: "short_response",
      grounding,
    });
    const approved = await library.approve(proposed.id, proposed.revision);

    expect(approved.outputAsset?.kind).toBe("application_response");
  });
});
