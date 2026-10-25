import { buildValuePreview } from "@nestor/ai-providers";
import {
  ResumeImportFieldCandidateSchema,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";

import { isObject, toStringArray } from "./resume-import-common";
import { normalizeText } from "./shared";

export function promoteGroundedSharedMemoryCandidates(
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[] {
  const summaryValues = new Set(
    candidates
      .filter(
        (
          candidate,
        ): candidate is ResumeImportFieldCandidate & { value: string } =>
          candidate.target.section === "identity" &&
          candidate.target.key === "summary" &&
          typeof candidate.value === "string",
      )
      .map((candidate) => normalizeText(candidate.value)),
  );
  const emailValues = new Set(
    candidates
      .filter(
        (
          candidate,
        ): candidate is ResumeImportFieldCandidate & { value: string } =>
          candidate.target.section === "contact" &&
          candidate.target.key === "email" &&
          typeof candidate.value === "string",
      )
      .map((candidate) => normalizeText(candidate.value)),
  );
  const phoneValues = new Set(
    candidates
      .filter(
        (
          candidate,
        ): candidate is ResumeImportFieldCandidate & { value: string } =>
          candidate.target.section === "contact" &&
          candidate.target.key === "phone" &&
          typeof candidate.value === "string",
      )
      .map((candidate) => normalizeText(candidate.value)),
  );
  const groundedLinkUrls = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.target.section === "link" &&
          candidate.resolution === "auto_applied" &&
          isObject(candidate.value),
      )
      .flatMap((candidate) => {
        if (!isObject(candidate.value)) {
          return [];
        }

        const value = candidate.value;
        return typeof value.url === "string" ? [normalizeText(value.url)] : [];
      }),
  );

  // Work-history bullets the experience read already captured. The shared
  // memory read re-states the strongest ones as proof points; keeping both
  // produced duplicate "achievement" cards repeating the work history.
  const experienceClaims = new Set(
    candidates
      .filter(
        (candidate) =>
          candidate.target.section === "experience" &&
          isObject(candidate.value),
      )
      .flatMap((candidate) => {
        if (!isObject(candidate.value)) return [];
        const record = candidate.value;
        return [
          ...toStringArray(record.achievements),
          ...toStringArray(record.highlights),
          ...(typeof record.summary === "string" ? [record.summary] : []),
        ].map((entry) => normalizeText(entry));
      }),
  );

  return candidates.map((candidate) => {
    // A story or self-introduction identical to the summary is dropped
    // even when reconciliation already applied it into the empty field:
    // the summary itself lands in Professional summary, and copying the
    // same paragraph into a second field leaves two copies to edit.
    if (
      (candidate.resolution === "needs_review" ||
        candidate.resolution === "auto_applied") &&
      typeof candidate.value === "string" &&
      summaryValues.has(normalizeText(candidate.value)) &&
      ((candidate.target.section === "narrative" &&
        candidate.target.key === "professionalStory") ||
        (candidate.target.section === "answer_bank" &&
          candidate.target.key === "selfIntroduction"))
    ) {
      return {
        ...candidate,
        resolution: "rejected" as const,
        resolutionReason: "redundant_with_professional_summary",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "proof_point" &&
      (candidate.resolution === "needs_review" ||
        candidate.resolution === "auto_applied")
    ) {
      const claim =
        typeof candidate.value === "string"
          ? candidate.value
          : isObject(candidate.value) &&
              typeof candidate.value.claim === "string"
            ? candidate.value.claim
            : null;
      if (claim && experienceClaims.has(normalizeText(claim))) {
        return {
          ...candidate,
          resolution: "rejected" as const,
          resolutionReason: "redundant_with_work_history",
          resolvedAt: new Date().toISOString(),
        };
      }
    }

    if (candidate.resolution !== "needs_review") {
      return candidate;
    }

    if (
      candidate.target.section === "narrative" &&
      candidate.target.key === "professionalStory" &&
      typeof candidate.value === "string" &&
      (summaryValues.has(normalizeText(candidate.value)) ||
        (candidate.confidence >= 0.9 &&
          typeof candidate.evidenceText === "string" &&
          summaryValues.has(normalizeText(candidate.evidenceText))))
    ) {
      // The resume summary already lands in the professional summary, which is
      // the field resumes read. Copying the identical paragraph into the
      // professional story too left the user editing one summary in three
      // places, so an identical value is dropped instead of duplicated.
      return {
        ...candidate,
        resolution: "rejected",
        resolutionReason: "redundant_with_professional_summary",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "answer_bank" &&
      candidate.target.key === "selfIntroduction" &&
      typeof candidate.value === "string" &&
      summaryValues.has(normalizeText(candidate.value))
    ) {
      // "How would you introduce yourself?" is a spoken answer that goes into
      // application forms. Pre-filling it with the written resume paragraph
      // put text the user was told to rewrite into their applications. Setup
      // offers the summary as a one-click suggestion instead, so the
      // identical paragraph is dropped rather than silently applied.
      return {
        ...candidate,
        resolution: "rejected",
        resolutionReason: "redundant_with_professional_summary",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "application_identity" &&
      candidate.target.key === "preferredEmail" &&
      typeof candidate.value === "string" &&
      emailValues.has(normalizeText(candidate.value))
    ) {
      return {
        ...candidate,
        resolution: "auto_applied",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "application_identity" &&
      candidate.target.key === "preferredPhone" &&
      typeof candidate.value === "string" &&
      phoneValues.has(normalizeText(candidate.value))
    ) {
      return {
        ...candidate,
        resolution: "auto_applied",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "application_identity" &&
      candidate.target.key === "preferredLinkUrls" &&
      toStringArray(candidate.value).length > 0 &&
      toStringArray(candidate.value).every((url) =>
        groundedLinkUrls.has(normalizeText(url)),
      )
    ) {
      return {
        ...candidate,
        resolution: "auto_applied",
        resolvedAt: new Date().toISOString(),
      };
    }

    if (
      candidate.target.section === "narrative" &&
      candidate.target.key === "careerTransitionSummary" &&
      typeof candidate.value === "string" &&
      candidate.confidence >= 0.9 &&
      candidate.sourceBlockIds.length > 0
    ) {
      return {
        ...candidate,
        resolution: "auto_applied",
        resolvedAt: new Date().toISOString(),
      };
    }

    return candidate;
  });
}

export function normalizeSharedMemoryCandidates(
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[] {
  return candidates.map((candidate) => {
    if (
      candidate.target.section !== "proof_point" ||
      candidate.target.key === "record"
    ) {
      return candidate;
    }

    if (
      candidate.target.key === "careerTransition" &&
      typeof candidate.value === "string"
    ) {
      return ResumeImportFieldCandidateSchema.parse({
        ...candidate,
        target: {
          section: "narrative",
          key: "careerTransitionSummary",
          recordId: null,
        },
        label: "Career transition summary",
      });
    }

    if (
      (candidate.target.key === "technicalAchievement" ||
        candidate.target.key === "leadershipAchievement") &&
      typeof candidate.value === "string"
    ) {
      return ResumeImportFieldCandidateSchema.parse({
        ...candidate,
        target: {
          section: "proof_point",
          key: "record",
          recordId:
            normalizeText(candidate.label).replace(/[^a-z0-9]+/g, "_") || null,
        },
        value: {
          title: candidate.label,
          claim: candidate.value,
          heroMetric:
            typeof candidate.normalizedValue === "string"
              ? candidate.normalizedValue
              : null,
          supportingContext: candidate.evidenceText,
          roleFamilies: [],
          projectIds: [],
          linkIds: [],
        },
        normalizedValue: null,
        valuePreview: buildValuePreview({
          title: candidate.label,
          claim: candidate.value,
          heroMetric:
            typeof candidate.normalizedValue === "string"
              ? candidate.normalizedValue
              : null,
          supportingContext: candidate.evidenceText,
        }),
      });
    }

    return candidate;
  });
}
