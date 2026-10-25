import type {
  ResumeDocumentBlock,
  ResumeDocumentBundle,
  ResumeDocumentParserKind,
  ResumeImportConfidenceBreakdown,
  ResumeImportFieldCandidateDraft,
  ResumeImportFieldSensitivity,
  ResumeImportResolutionRecommendation,
} from "@nestor/contracts";

export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export function inferFieldSensitivity(
  target: ResumeImportFieldCandidateDraft["target"],
): ResumeImportFieldSensitivity {
  if (target.section === "link") {
    return "low";
  }

  if (target.section === "experience" || target.section === "education") {
    return "high";
  }

  if (target.section === "narrative" || target.section === "proof_point") {
    return "medium";
  }

  if (
    target.key === "fullName" ||
    target.key === "email" ||
    target.key === "phone" ||
    target.key === "currentLocation" ||
    target.key === "linkedinUrl" ||
    target.key === "githubUrl" ||
    target.key === "portfolioUrl" ||
    target.key === "personalWebsiteUrl" ||
    target.key === "preferredEmail" ||
    target.key === "preferredPhone"
  ) {
    return "low";
  }

  return "medium";
}

export function sensitivityToRisk(
  sensitivity: ResumeImportFieldSensitivity,
): number {
  switch (sensitivity) {
    case "low":
      return 0.12;
    case "medium":
      return 0.28;
    case "high":
      return 0.48;
    case "critical":
      return 0.72;
    default:
      return 0.28;
  }
}

export function recommendationFromConfidence(input: {
  overall: number;
  fieldSensitivity: ResumeImportFieldSensitivity;
}): ResumeImportResolutionRecommendation {
  const overall = normalizeConfidence(input.overall);

  if (input.fieldSensitivity === "low" && overall >= 0.8) {
    return "auto_apply";
  }

  if (input.fieldSensitivity === "medium" && overall >= 0.88) {
    return "auto_apply";
  }

  if (overall < 0.35) {
    return "abstain";
  }

  return "needs_review";
}

function blockAgreementScore(
  bundle: ResumeDocumentBundle,
  blockIds: readonly string[],
): number {
  if (blockIds.length === 0) {
    return 0.34;
  }

  const blocks = blockIds
    .map((id) => bundle.blocks.find((block) => block.id === id))
    .filter((block): block is ResumeDocumentBlock => Boolean(block));

  if (blocks.length === 0) {
    return 0.34;
  }

  const lineage = new Set<ResumeDocumentParserKind>();
  for (const block of blocks) {
    for (const parserKind of block.sourceParserKinds) {
      lineage.add(parserKind);
    }
    for (const parserKind of block.parserLineage ?? []) {
      lineage.add(parserKind);
    }
  }

  if (lineage.size >= 2) {
    return 0.92;
  }

  return blocks.length >= 2 ? 0.74 : 0.58;
}

export function buildCandidateConfidenceBreakdown(input: {
  candidate: Pick<
    ResumeImportFieldCandidateDraft,
    "target" | "confidence" | "sourceBlockIds"
  >;
  bundle: ResumeDocumentBundle;
  conflictRisk?: number;
  normalizationRisk?: number;
}): ResumeImportConfidenceBreakdown {
  const fieldSensitivity = inferFieldSensitivity(input.candidate.target);
  const parserKind = input.bundle.primaryParserKind;
  const parserQuality = normalizeConfidence(
    input.bundle.quality?.score ??
      (parserKind === "plain_text" ||
      parserKind === "pdfjs_text" ||
      parserKind === "macos_pdfkit_text" ||
      parserKind === "local_pdf_text_probe" ||
      parserKind === "local_pdf_layout" ||
      parserKind === "local_docx"
        ? 0.86
        : input.bundle.route?.routeKind === "native_first"
          ? 0.86
          : 0.78),
  );
  const evidenceQuality = normalizeConfidence(
    input.candidate.sourceBlockIds.length > 0 ? 0.94 : 0.42,
  );
  const agreementScore = blockAgreementScore(
    input.bundle,
    input.candidate.sourceBlockIds,
  );
  const normalizationRisk = normalizeConfidence(
    input.normalizationRisk ?? 0.14,
  );
  const conflictRisk = normalizeConfidence(
    input.conflictRisk ?? sensitivityToRisk(fieldSensitivity) * 0.5,
  );

  const overall = normalizeConfidence(
    input.candidate.confidence * 0.45 +
      parserQuality * 0.2 +
      evidenceQuality * 0.18 +
      agreementScore * 0.17 -
      normalizationRisk * 0.12 -
      conflictRisk * 0.16,
  );

  return {
    overall,
    parserQuality,
    evidenceQuality,
    agreementScore,
    normalizationRisk,
    conflictRisk,
    fieldSensitivity,
    recommendation: recommendationFromConfidence({ overall, fieldSensitivity }),
  };
}
