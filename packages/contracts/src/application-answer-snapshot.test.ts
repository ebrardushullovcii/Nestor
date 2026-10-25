import { describe, expect, it } from "vitest";
import { CandidateProfileSchema } from "./profile";

import {
  deriveApprovedApplicationAnswerSnapshotContent,
  ApprovedApplicationAnswerSnapshotSchema,
  serializeApprovedApplicationAnswerSnapshotForDigest,
} from "./application-answer-snapshot";

const entry = {
  id: "profile:workAuthorization",
  kind: "work_authorization" as const,
  label: "Work authorization",
  question: "Are you authorized to work in the selected countries?",
  answer: "Yes, in the countries saved in my profile.",
  roleFamilies: ["platform", "product"],
  proofEntryIds: ["proof_2", "proof_1"],
};

describe("approved application answer snapshots", () => {
  it("parses immutable answer content with main-owned lifecycle identity", () => {
    expect(
      ApprovedApplicationAnswerSnapshotSchema.parse({
        schemaVersion: 1,
        id: "answer_snapshot_1",
        revision: 1,
        digest: "a".repeat(64),
        profileId: "profile_1",
        sourceProfileRevision: 7,
        entries: [entry],
        approvedAt: "2026-08-28T10:00:00.000Z",
      }),
    ).toMatchObject({
      id: "answer_snapshot_1",
      revision: 1,
      sourceProfileRevision: 7,
    });
  });

  it("canonicalizes entry and nested reference order for digest generation", () => {
    const second = {
      ...entry,
      id: "profile:visaSponsorship",
      kind: "visa_sponsorship" as const,
      label: "Visa sponsorship",
      question: "Will you need sponsorship?",
      answer: "No.",
    };
    const first = serializeApprovedApplicationAnswerSnapshotForDigest({
      schemaVersion: 1,
      profileId: "profile_1",
      entries: [second, entry],
    });
    const reordered = serializeApprovedApplicationAnswerSnapshotForDigest({
      schemaVersion: 1,
      profileId: "profile_1",
      entries: [
        { ...entry, roleFamilies: [...entry.roleFamilies].reverse() },
        second,
      ],
    });
    expect(reordered).toBe(first);
    expect(first.indexOf(second.id)).toBeLessThan(first.indexOf(entry.id));
  });

  it("rejects duplicate entry identity and unbounded answer content", () => {
    expect(
      ApprovedApplicationAnswerSnapshotSchema.safeParse({
        schemaVersion: 1,
        id: "answer_snapshot_1",
        revision: 1,
        digest: "a".repeat(64),
        profileId: "profile_1",
        sourceProfileRevision: 1,
        entries: [entry, entry],
        approvedAt: "2026-08-28T10:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ApprovedApplicationAnswerSnapshotSchema.safeParse({
        schemaVersion: 1,
        id: "answer_snapshot_1",
        revision: 1,
        digest: "a".repeat(64),
        profileId: "profile_1",
        sourceProfileRevision: 1,
        entries: [{ ...entry, answer: "x".repeat(20_001) }],
        approvedAt: "2026-08-28T10:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

it("unconfirmed old agent answers never enter the approved answer snapshot", () => {
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    yearsExperience: 0,
    baseResume: {
      id: "resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T10:00:00.000Z",
      storagePath: "/synthetic",
      textContent: "Synthetic",
    },
  });
  const answers = [
    {
      id: "saved-1",
      kind: "other" as const,
      label: "Experience",
      question: "Years?",
      answer: "0",
      needsConfirmation: true,
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  expect(
    deriveApprovedApplicationAnswerSnapshotContent(profile, answers).entries,
  ).toEqual([]);
  answers[0]!.needsConfirmation = false;
  expect(
    deriveApprovedApplicationAnswerSnapshotContent(profile, answers).entries[0]
      ?.answer,
  ).toBe("0");
});
