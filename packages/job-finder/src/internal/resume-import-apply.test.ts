import { resumeImportSavedAnswers } from "./resume-import-saved-answers";
import { describe, expect, test } from "vitest";

import {
  ResumeImportFieldCandidateSchema,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";

import { createSeed } from "../workspace-service.test-fixtures";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./resume-import-apply";

const createdAt = "2026-08-02T10:00:00.000Z";

function contactCandidate(
  key: "email" | "phone",
  value: string,
): ResumeImportFieldCandidate {
  return ResumeImportFieldCandidateSchema.parse({
    id: `candidate_${key}`,
    runId: "run_contact_sync",
    target: { section: "contact", key, recordId: null },
    label: key === "email" ? "Email" : "Phone",
    sourceKind: "parser_literal",
    value,
    valuePreview: value,
    evidenceText: value,
    sourceBlockIds: [`block_${key}`],
    confidence: 0.99,
    resolution: "auto_applied",
    resolutionReason: "high_confidence_literal_with_direct_evidence",
    createdAt,
    resolvedAt: createdAt,
  });
}

function applyImportedContacts(
  profile: ReturnType<typeof createSeed>["profile"],
) {
  const seed = createSeed();
  return applyResolvedResumeImportCandidatesToWorkspace({
    profile,
    searchPreferences: seed.searchPreferences,
    candidates: [
      contactCandidate("email", "jamie@example.com"),
      contactCandidate("phone", "+49 555 0000000"),
    ],
    analysisProviderKind: "deterministic",
    analysisProviderLabel: "Deterministic test provider",
    analysisWarnings: [],
  }).profile;
}

describe("resume import preferred contact synchronization", () => {
  test("moves mirrored preferred contacts with accepted new primary contacts", () => {
    const profile = applyImportedContacts(createSeed().profile);

    expect(profile.email).toBe("jamie@example.com");
    expect(profile.phone).toBe("+49 555 0000000");
    expect(profile.applicationIdentity.preferredEmail).toBe(
      "jamie@example.com",
    );
    expect(profile.applicationIdentity.preferredPhone).toBe("+49 555 0000000");
  });

  test("preserves genuinely distinct preferred contact overrides", () => {
    const seed = createSeed();
    const profile = applyImportedContacts({
      ...seed.profile,
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredEmail: "applications@example.com",
        preferredPhone: "+383 44 000 000",
      },
    });

    expect(profile.email).toBe("jamie@example.com");
    expect(profile.phone).toBe("+49 555 0000000");
    expect(profile.applicationIdentity.preferredEmail).toBe(
      "applications@example.com",
    );
    expect(profile.applicationIdentity.preferredPhone).toBe("+383 44 000 000");
  });

  test("keeps an accepted synthetic candidate contact and location tuple coherent", () => {
    const seed = createSeed();
    const contactProfile = applyImportedContacts(seed.profile);
    const locationCandidate = ResumeImportFieldCandidateSchema.parse({
      id: "candidate_current_location",
      runId: "run_contact_sync",
      target: { section: "location", key: "currentLocation", recordId: null },
      label: "Current location",
      sourceKind: "parser_literal",
      value: "Berlin, Germany",
      valuePreview: "Berlin, Germany",
      evidenceText: "Berlin, Germany",
      sourceBlockIds: ["block_location"],
      confidence: 0.99,
      resolution: "auto_applied",
      resolutionReason: "review_confirmed",
      createdAt,
      resolvedAt: createdAt,
    });
    const profile = applyResolvedResumeImportCandidatesToWorkspace({
      profile: contactProfile,
      searchPreferences: seed.searchPreferences,
      candidates: [locationCandidate],
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Deterministic test provider",
      analysisWarnings: [],
    }).profile;

    expect({
      email: profile.email,
      phone: profile.phone,
      currentLocation: profile.currentLocation,
      currentCountry: profile.currentCountry,
      preferredEmail: profile.applicationIdentity.preferredEmail,
      preferredPhone: profile.applicationIdentity.preferredPhone,
    }).toEqual({
      email: "jamie@example.com",
      phone: "+49 555 0000000",
      currentLocation: "Berlin, Germany",
      currentCountry: "Germany",
      preferredEmail: "jamie@example.com",
      preferredPhone: "+49 555 0000000",
    });
  });
});

describe("explicit approval of imported preferences", () => {
  test.each([false, true])(
    "hours only replace a saved choice when explicitly confirmed (%s)",
    (confirmed) => {
      const seed = createSeed();
      const imported = ResumeImportFieldCandidateSchema.parse({
        ...contactCandidate("email", "placeholder@example.test"),
        id: "hours",
        target: {
          section: "search_preferences",
          key: "employmentTypes",
          recordId: null,
        },
        value: ["Part-time"],
      });
      const result = applyResolvedResumeImportCandidatesToWorkspace({
        profile: seed.profile,
        searchPreferences: {
          ...seed.searchPreferences,
          employmentTypes: ["Full-time"],
        },
        candidates: [imported],
        confirmedCandidateId: confirmed ? imported.id : null,
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      });
      expect(result.searchPreferences.employmentTypes).toEqual([
        confirmed ? "Part-time" : "Full-time",
      ]);
    },
  );
  test.each([false, true])(
    "pay only replaces a saved choice when explicitly confirmed (%s)",
    (confirmed) => {
      const seed = createSeed();
      const saved = {
        minimum: 70000,
        maximum: null,
        interval: "year" as const,
        currency: "USD",
        currencyStatus: "explicit" as const,
      };
      const next = { ...saved, minimum: 90000, currency: "EUR" };
      const imported = ResumeImportFieldCandidateSchema.parse({
        ...contactCandidate("email", "placeholder@example.test"),
        id: "pay",
        target: {
          section: "search_preferences",
          key: "compensation",
          recordId: null,
        },
        value: next,
      });
      const result = applyResolvedResumeImportCandidatesToWorkspace({
        profile: seed.profile,
        searchPreferences: {
          ...seed.searchPreferences,
          minimumSalaryUsd: 70000,
          compensation: saved,
        },
        candidates: [imported],
        confirmedCandidateId: confirmed ? imported.id : null,
        analysisProviderKind: "deterministic",
        analysisProviderLabel: "Test",
        analysisWarnings: [],
      });
      expect(result.searchPreferences.compensation).toEqual(
        confirmed ? next : saved,
      );
      expect(result.searchPreferences.salaryCurrency).toBe(
        confirmed ? "EUR" : "USD",
      );
    },
  );
});

test("accepted reusable import text targets saved answers, with unresolved suggestions left for review", () => {
  const accepted = ResumeImportFieldCandidateSchema.parse({
    ...contactCandidate("email", "I build reporting tools."),
    target: { section: "answer_bank", key: "selfIntroduction", recordId: null },
    label: "Introduction",
  });
  expect(
    resumeImportSavedAnswers([
      accepted,
      { ...accepted, id: "unreviewed", resolution: "needs_review" },
    ]),
  ).toEqual([
    {
      key: "resume_import:self_intro",
      kind: "self_intro",
      prompt: "Introduction",
      label: "Introduction",
      answer: "I build reporting tools.",
      input: "text",
      needsConfirmation: false,
    },
  ]);
});
