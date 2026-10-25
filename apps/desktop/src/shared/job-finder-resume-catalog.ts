import {
  getResumeTemplateAtsConfidence,
  getResumeTemplateDeliveryLane,
  getResumeTemplateFamilyId,
  getResumeTemplateFamilyLabel,
  type ResumeTemplateAtsConfidence,
  type ResumeTemplateDefinition,
  type ResumeTemplateDeliveryLane,
  type ResumeTemplateId,
} from "@nestor/contracts";

const resumeTemplates = [
  {
    id: "classic_ats",
    label: "Chronology Classic",
    familyId: "chronology_classic",
    familyLabel: "Chronology Classic",
    familyDescription:
      "Traditional chronology-first typesetting with serif identity, disciplined rules, and the section order recruiters expect.",
    variantLabel: "Traditional Standard",
    description:
      "A formal serif-led resume with crisp dividers, compact contact details, and familiar reverse chronology for broad ATS-safe use.",
    fitSummary:
      "Strong default when the safest move is a familiar recruiter read: identity, summary, skills, then reverse chronology.",
    avoidSummary:
      "Less distinctive when long history, credentials, projects, or a career-pivot bridge need to lead the story.",
    bestFor: [
      "General applications",
      "Recruiter screens",
      "Conservative ATS submissions",
    ],
    visualTags: ["Standard ATS", "Reverse chronology", "Traditional"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 10,
  },
  {
    id: "modern_split",
    label: "Modern Editorial",
    familyId: "modern_editorial",
    familyLabel: "Modern Editorial",
    familyDescription:
      "Contemporary editorial typesetting with decisive asymmetry, colored rules, and generous but efficient vertical rhythm.",
    variantLabel: "Editorial Standard",
    description:
      "A left-aligned modern resume with a strong typographic masthead, a ruled opening statement, and balanced proof sections.",
    fitSummary:
      "Useful when you want a confident, contemporary first impression without leaving the single-column apply-safe lane.",
    avoidSummary:
      "Less helpful if a dense long-history timeline, credentials, or a highly technical skills-first scan is the main differentiator.",
    bestFor: ["Product roles", "Design-adjacent teams", "Startup hiring loops"],
    visualTags: ["Modern professional", "Single column", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 30,
  },
  {
    id: "compact_exec",
    label: "Senior Brief",
    familyId: "senior_brief",
    familyLabel: "Senior Brief",
    familyDescription:
      "Dense senior layouts that compress signal through strong hierarchy, short rules, and a tightly paced leadership chronology.",
    variantLabel: "Executive Timeline",
    description:
      "A compact executive read with centered identity, understated contact line, compressed summary, and tight reverse chronology.",
    fitSummary:
      "Best when you have strong experience density and want more signal visible before page pressure becomes a problem.",
    avoidSummary:
      "Can feel tight for early-career profiles or resumes that need extra whitespace to breathe.",
    bestFor: [
      "Senior candidates",
      "Content-dense resumes",
      "Leadership screens",
    ],
    visualTags: ["Experienced professional", "Dense timeline", "High signal"],
    density: "compact",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 20,
  },
  {
    id: "credentials_focus",
    label: "Formal Proof",
    familyId: "credential_ledger",
    familyLabel: "Formal Proof",
    familyDescription:
      "Trust-first editorial layouts that use classical typography and ledger-like rules to bring formal proof forward.",
    variantLabel: "Credential Ledger",
    description:
      "A classical credential ledger that opens with certifications and education, then moves into summary, skills, and chronology.",
    fitSummary:
      "Stronger when credentials, certifications, or formal education materially change recruiter trust or screening outcomes.",
    avoidSummary:
      "Less effective if credentials are thin and your strongest evidence is shipped work or technical systems depth.",
    bestFor: [
      "Regulated industries",
      "Certification-heavy roles",
      "Academic backgrounds",
    ],
    visualTags: ["Credential ledger", "Classical type", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 60,
  },
  {
    id: "technical_matrix",
    label: "Engineering Spec",
    familyId: "engineering_spec",
    familyLabel: "Engineering Spec",
    familyDescription:
      "Specification-inspired layouts with compact technical labels, blue rules, structured skills, and engineering-first scan order.",
    variantLabel: "Technical Brief",
    description:
      "A compact technical brief that surfaces grouped systems depth before summary and chronology without tables or sidebars.",
    fitSummary:
      "Best when technical skill grouping and systems credibility need to land before the reader reaches your experience timeline.",
    avoidSummary:
      "Can feel overly technical for generalist roles where the strongest signal is leadership story or project proof.",
    bestFor: ["Engineering roles", "Data roles", "Security roles"],
    visualTags: ["Technical brief", "Skills first", "Compact"],
    density: "compact",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 40,
  },
  {
    id: "project_showcase",
    label: "Proof Portfolio",
    familyId: "proof_portfolio",
    familyLabel: "Proof Portfolio",
    familyDescription:
      "Proof-led editorial layouts with an expressive masthead, plum rules, and generous spacing around shipped outcomes.",
    variantLabel: "Selected Work",
    description:
      "A project-first editorial resume for candidates whose strongest evidence is shipped work, ownership, and measurable outcomes.",
    fitSummary:
      "Useful when projects, launches, or portfolio proof tell the clearest case for fit.",
    avoidSummary:
      "Less ideal when you need a conservative recruiter-first chronology or stronger credentials signal up front.",
    bestFor: [
      "Portfolio-heavy candidates",
      "Career changers",
      "Product builders",
    ],
    visualTags: ["Selected work", "Proof led", "Comfortable"],
    density: "comfortable",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 50,
  },
  {
    id: "timeline_longform",
    label: "Longform Timeline",
    familyId: "longform_timeline",
    familyLabel: "Longform Timeline",
    familyDescription:
      "Long-history layouts that use compact newspaper-like rules, a factual career index, and chaptered chronology.",
    variantLabel: "Career Archive",
    description:
      "A compact career archive with a factual snapshot, chapter-style experience entries, and low-friction scanning across many roles.",
    fitSummary:
      "Best when the draft includes many relevant or gap-covering roles and the reader needs fast orientation before the full chronology.",
    avoidSummary:
      "Overkill for thin or early-career resumes where a simpler chronology or project-led read would feel more focused.",
    bestFor: [
      "Long work histories",
      "Senior ICs",
      "Mixed chronology with gap coverage",
    ],
    visualTags: ["Career archive", "Chaptered history", "Compact"],
    density: "compact",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 70,
  },
  {
    id: "career_pivot",
    label: "Career Pivot Bridge",
    familyId: "career_pivot_bridge",
    familyLabel: "Career Pivot Bridge",
    familyDescription:
      "Hybrid layouts with a grounded green accent and narrative-to-proof sequence that connects transferable work to the target role.",
    variantLabel: "Transferable Proof",
    description:
      "A narrative-led career-pivot resume that moves from transferable strengths to role-ready skills, project proof, and chronology.",
    fitSummary:
      "Useful when mixed or dev-adjacent history needs a clear bridge from past roles to the target job before the timeline begins.",
    avoidSummary:
      "Less ideal when the candidate already has a straightforward same-lane chronology that should lead without explanation.",
    bestFor: ["Career pivots", "Mixed backgrounds", "Dev-adjacent evidence"],
    visualTags: ["Transferable proof", "Narrative bridge", "Balanced"],
    density: "balanced",
    deliveryLane: "apply_safe",
    atsConfidence: "high",
    applyEligible: true,
    approvalEligible: true,
    benchmarkEligible: true,
    sortOrder: 80,
  },
] satisfies readonly ResumeTemplateDefinition[];

export interface LocalResumeTemplateFamily {
  id: string;
  label: string;
  description: string;
  deliveryLane: ResumeTemplateDeliveryLane;
  atsConfidence: ResumeTemplateAtsConfidence;
  sortOrder: number;
  templates: readonly ResumeTemplateDefinition[];
}

function sortTemplateDefinitions(
  left: ResumeTemplateDefinition,
  right: ResumeTemplateDefinition,
): number {
  return (
    (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.sortOrder ?? Number.MAX_SAFE_INTEGER)
  );
}

export function listLocalResumeTemplates(): readonly ResumeTemplateDefinition[] {
  return [...resumeTemplates].sort(sortTemplateDefinitions);
}

export function getLocalResumeTemplateDefinition(
  templateId: ResumeTemplateId,
): ResumeTemplateDefinition {
  if (resumeTemplates.length === 0) {
    throw new Error("Expected at least one local resume template");
  }

  return (
    resumeTemplates.find((template) => template.id === templateId) ??
    resumeTemplates[0]!
  );
}

export function getDefaultApplySafeResumeTemplateId(): ResumeTemplateId {
  if (resumeTemplates.length === 0) {
    throw new Error("Expected at least one local resume template");
  }

  return (
    resumeTemplates.find(
      (template) =>
        template.deliveryLane === "apply_safe" && template.applyEligible,
    )?.id ?? resumeTemplates[0]!.id
  );
}

export function listLocalResumeTemplateFamilies(): readonly LocalResumeTemplateFamily[] {
  const templatesByFamily = new Map<string, ResumeTemplateDefinition[]>();

  for (const template of listLocalResumeTemplates()) {
    const familyId = getResumeTemplateFamilyId(template);
    const existingTemplates = templatesByFamily.get(familyId) ?? [];
    existingTemplates.push(template);
    templatesByFamily.set(familyId, existingTemplates);
  }

  return [...templatesByFamily.entries()]
    .map(([familyId, templates]) => {
      const primaryTemplate = templates[0]!;
      const familyDescription = templates
        .find((template) => template.familyDescription?.trim())
        ?.familyDescription?.trim();

      return {
        id: familyId,
        label: getResumeTemplateFamilyLabel(primaryTemplate),
        description: familyDescription ?? primaryTemplate.description,
        deliveryLane: getResumeTemplateDeliveryLane(primaryTemplate),
        atsConfidence: getResumeTemplateAtsConfidence(primaryTemplate),
        sortOrder: primaryTemplate.sortOrder ?? Number.MAX_SAFE_INTEGER,
        templates,
      } satisfies LocalResumeTemplateFamily;
    })
    .sort((left, right) => left.sortOrder - right.sortOrder);
}
