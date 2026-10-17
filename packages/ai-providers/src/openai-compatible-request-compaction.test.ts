import { describe, expect, test } from "vitest";

import { ResumeImportJsonValueSchema } from "@nestor/contracts";

import {
  compactOpenAiCompatibleUserPayload,
  type OpenAiCompatibleJsonOperation,
} from "./openai-compatible-request-compaction";

const SYSTEM_PROMPT = "You are a grounded resume drafting assistant.";
const LEVEL_ONE_EVIDENCE_ITEM_LIMIT = 64;
const BOUNDED_OMITTED_ID_CHARS = 96;

interface GroundingEvidenceItem {
  id?: string;
  text?: string;
  scope?: string;
  profileRecordId?: string | null;
}

interface GroundingCompactionMetadata {
  applied?: boolean;
  note?: string;
  originalItemCount?: number;
  includedItemCount?: number;
  omittedItemCount?: number;
  omittedScopeCounts?: Record<string, number>;
  omittedIdsPreview?: string[];
}

interface GroundedResumePayload {
  baseResumeText?: string;
  targetJob?: Record<string, unknown>;
  groundingEvidence?: {
    version?: number;
    items?: GroundingEvidenceItem[];
    compaction?: GroundingCompactionMetadata;
  };
}

// Mirrors the internal budget arithmetic so tests can prove the compacted
// payload stays inside the model input budget.
function computeExpectedCharBudget(modelContextWindowTokens: number): number {
  const promptTokens = Math.ceil(SYSTEM_PROMPT.length / 3);
  const availableInputTokens =
    Math.floor(modelContextWindowTokens * 0.72) - 4_096 - promptTokens;

  return availableInputTokens * 3;
}

function buildLongResumeText(): string {
  const head =
    "HEAD_SENTINEL Alex Vanguard, senior platform engineer with 12 years of experience. ";
  const body = "Historical role detail paragraph. ".repeat(230);
  const tail =
    "TAIL_SENTINEL Most recent role: staff engineer leading the payments platform migration.";

  return `${head}${body}${tail}`;
}

function buildVeryLongResumeText(): string {
  const head =
    "HEAD_SENTINEL Alex Vanguard, senior platform engineer with 12 years of experience. ";
  const body = "Historical role detail paragraph. ".repeat(1170);
  const tail =
    "TAIL_SENTINEL Most recent role: staff engineer leading the payments platform migration.";

  return `${head}${body}${tail}`;
}

function buildProfileFillerItem(index: number): GroundingEvidenceItem {
  return {
    id: `profile:filler:${index}`,
    text: `Generic profile filler ${index}: ${"detail ".repeat(100)}`,
    scope: "profile",
    profileRecordId: null,
  };
}

function buildShortProfileFillerItem(index: number): GroundingEvidenceItem {
  return {
    id: `profile:filler:${index}`,
    text: `Generic profile filler ${index}: ${"detail ".repeat(42)}`,
    scope: "profile",
    profileRecordId: null,
  };
}

function buildMultiRoleCandidateEvidence(
  resumeText: string,
): GroundingEvidenceItem[] {
  return [
    {
      id: "experience:exp_alpha_2021:summary",
      text: "Senior Platform Engineer at Northwind Systems owning the payments platform migration to event-driven services.",
      scope: "experience",
      profileRecordId: "exp_alpha_2021",
    },
    {
      id: "experience:exp_alpha_2021:achievement:0",
      text: "Cut checkout p95 latency by 41% while migrating 120 services onto the event-driven payments platform.",
      scope: "experience",
      profileRecordId: "exp_alpha_2021",
    },
    {
      id: "experience:exp_alpha_2021:skills",
      text: "TypeScript, Kafka, Kubernetes, PostgreSQL",
      scope: "experience",
      profileRecordId: "exp_alpha_2021",
    },
    {
      id: "experience:exp_beta_2018:summary",
      text: "Full-stack Engineer at Harbor Light Labs building logistics dashboards for warehouse operations teams.",
      scope: "experience",
      profileRecordId: "exp_beta_2018",
    },
    {
      id: "experience:exp_beta_2018:achievement:0",
      text: "Shipped route optimization that reduced fleet idle time by 18% across 14 depots.",
      scope: "experience",
      profileRecordId: "exp_beta_2018",
    },
    {
      id: "project:proj_orion:summary",
      text: "Orion: open-source workflow orchestrator adopted by three Fortune 500 logistics teams.",
      scope: "project",
      profileRecordId: "proj_orion",
    },
    {
      id: "project:proj_orion:outcome",
      text: "Grew Orion to 2.4k GitHub stars and a 40-contributor community.",
      scope: "project",
      profileRecordId: "proj_orion",
    },
    {
      id: "project:proj_helios:summary",
      text: "Helios: internal developer platform that cut service onboarding time from two weeks to two days.",
      scope: "project",
      profileRecordId: "proj_helios",
    },
    {
      id: "proof:proof_northwind:claim",
      text: "Named primary inventor on the Northwind streaming ingestion patent filing.",
      scope: "proof",
      profileRecordId: "proof_northwind",
    },
    {
      id: "importEvidence:summary:0",
      text: "Imported summary evidence describing reliability engineering ownership for operations teams.",
      scope: "import_evidence",
      profileRecordId: null,
    },
    {
      id: "importEvidence:skills",
      text: "TypeScript, Kafka, Terraform",
      scope: "import_evidence",
      profileRecordId: null,
    },
    {
      id: "baseResume:text",
      text: resumeText,
      scope: "import_evidence",
      profileRecordId: null,
    },
  ];
}

function buildTargetJob(): Record<string, unknown> {
  return {
    title: "Staff Platform Engineer",
    company: "Cirrus Commerce",
    description: "Own the payments platform and developer experience.",
    responsibilities: ["Lead the platform migration"],
    minimumQualifications: ["8 years backend experience"],
    preferredQualifications: ["Event-driven architecture experience"],
    keySkills: ["TypeScript", "Kafka"],
    keywordSignals: [],
  };
}

function buildGroundedResumePayload(input: {
  resumeText: string;
  profileFillerCount: number;
  shortFillers?: boolean;
}): Record<string, unknown> {
  const fillerBuilder = input.shortFillers
    ? buildShortProfileFillerItem
    : buildProfileFillerItem;

  return {
    baseResumeText: input.resumeText,
    targetJob: buildTargetJob(),
    groundingEvidence: {
      version: 1,
      items: [
        ...Array.from({ length: input.profileFillerCount }, (_, index) =>
          fillerBuilder(index),
        ),
        ...buildMultiRoleCandidateEvidence(input.resumeText),
      ],
    },
  };
}

describe("openai compatible request compaction for grounded resume generation", () => {
  test("returns grounded resume payloads unchanged while every field is within its level-one bound", () => {
    const resumeText =
      "Alex Vanguard, senior platform engineer. HEAD_SENTINEL compact verified resume body. TAIL_SENTINEL staff engineer leading the payments platform migration.";
    const userPayload = buildGroundedResumePayload({
      resumeText,
      profileFillerCount: 5,
    });

    const operations: OpenAiCompatibleJsonOperation[] = [
      "createResumeDraft",
      "tailorResume",
    ];
    for (const operation of operations) {
      const compacted = compactOpenAiCompatibleUserPayload({
        operation,
        modelContextWindowTokens: null,
        systemPrompt: SYSTEM_PROMPT,
        userPayload,
      });

      expect(compacted).toEqual(userPayload);

      const grounded = compacted as unknown as GroundedResumePayload;
      expect(grounded.baseResumeText).toBe(resumeText);
      expect(grounded.groundingEvidence?.items).toHaveLength(17);
      expect(
        grounded.groundingEvidence?.items?.map((item) => item.id),
      ).toContain("baseResume:text");
      expect(grounded.groundingEvidence?.compaction).toBeUndefined();
    }
  });

  test("field-bounds oversized individual fields even when the total payload fits the model input budget", () => {
    const oversizedDescription = `Job description ${"requirement ".repeat(5000)}`;
    const userPayload: Record<string, unknown> = {
      baseResumeText: "Small base resume for the lean contract scenario.",
      targetJob: {
        ...buildTargetJob(),
        description: oversizedDescription,
      },
      groundingEvidence: {
        version: 1,
        items: [
          {
            id: "profile:skills",
            text: "TypeScript, Kafka, Kubernetes",
            scope: "profile",
            profileRecordId: null,
          },
          {
            id: "experience:exp_one:summary",
            text: "Owned platform reliability for enterprise operations teams.",
            scope: "experience",
            profileRecordId: "exp_one",
          },
          {
            id: "baseResume:text",
            text: "Small base resume for the lean contract scenario.",
            scope: "import_evidence",
            profileRecordId: null,
          },
        ],
      },
    };

    // The total payload fits the default model budget comfortably, but the
    // description alone exceeds its level-one field bound.
    expect(JSON.stringify(userPayload).length).toBeLessThanOrEqual(
      computeExpectedCharBudget(196_000),
    );

    const compacted = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: null,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });

    expect(ResumeImportJsonValueSchema.safeParse(compacted).success).toBe(true);

    const grounded = compacted as unknown as GroundedResumePayload;
    const boundedDescription =
      (grounded.targetJob as { description?: string } | undefined)
        ?.description ?? "";

    expect(boundedDescription.length).toBeLessThan(oversizedDescription.length);
    expect(boundedDescription.length).toBeLessThanOrEqual(12_010);
    expect(boundedDescription).toContain("[truncated");
    expect(boundedDescription.startsWith("Job description")).toBe(true);

    // Normal-sized tailoring inputs pass through unchanged.
    expect(grounded.baseResumeText).toBe(
      "Small base resume for the lean contract scenario.",
    );
    expect(grounded.groundingEvidence?.items?.map((item) => item.id)).toEqual([
      "profile:skills",
      "experience:exp_one:summary",
      "baseResume:text",
    ]);

    // No evidence was omitted, so no omission metadata is emitted.
    expect(grounded.groundingEvidence?.compaction).toBeUndefined();
  });

  test("keeps candidate-critical tailoring evidence ahead of generic profile items when an oversized createResumeDraft request is compacted", () => {
    const resumeText = buildLongResumeText();
    const userPayload = buildGroundedResumePayload({
      resumeText,
      profileFillerCount: 100,
    });
    const criticalIds = [
      "experience:exp_alpha_2021:summary",
      "experience:exp_alpha_2021:achievement:0",
      "experience:exp_alpha_2021:skills",
      "experience:exp_beta_2018:summary",
      "experience:exp_beta_2018:achievement:0",
      "project:proj_orion:summary",
      "project:proj_orion:outcome",
      "project:proj_helios:summary",
      "proof:proof_northwind:claim",
      "importEvidence:summary:0",
      "importEvidence:skills",
      "baseResume:text",
    ];

    const compacted = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 40_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });

    expect(ResumeImportJsonValueSchema.safeParse(compacted).success).toBe(true);

    const grounded = compacted as unknown as GroundedResumePayload;

    // The base resume text is recognized as long resume input and survives
    // level-one compaction instead of being cut to a generic ~600 char limit.
    expect(grounded.baseResumeText).toBe(resumeText);

    const items = grounded.groundingEvidence?.items ?? [];
    expect(items).toHaveLength(LEVEL_ONE_EVIDENCE_ITEM_LIMIT);
    expect(items.map((item) => item.id)).toEqual(
      expect.arrayContaining(criticalIds),
    );

    // The original-resume anchor is reserved ahead of everything else and
    // candidate-critical evidence precedes any generic profile filler.
    expect(items[0]?.id).toBe("baseResume:text");
    const firstProfileIndex = items.findIndex(
      (item) => item.scope === "profile",
    );
    const baseResumeIndex = items.findIndex(
      (item) => item.id === "baseResume:text",
    );
    expect(firstProfileIndex).toBeGreaterThan(-1);
    expect(baseResumeIndex).toBeLessThan(firstProfileIndex);
    expect(
      items
        .filter((item) => item.scope === "profile")
        .every((item) => Number((item.id ?? "").split(":").pop()) <= 51),
    ).toBe(true);

    // Supported multi-role prose survives verbatim for tailoring.
    const serializedItems = JSON.stringify(items);
    expect(serializedItems).toContain("payments platform migration");
    expect(serializedItems).toContain("route optimization");

    // Omitted evidence is disclosed through inspectable metadata.
    const metadata = grounded.groundingEvidence?.compaction;
    expect(metadata?.applied).toBe(true);
    expect(metadata?.originalItemCount).toBe(112);
    expect(metadata?.includedItemCount).toBe(LEVEL_ONE_EVIDENCE_ITEM_LIMIT);
    expect(metadata?.omittedItemCount).toBe(48);
    expect(metadata?.omittedScopeCounts).toEqual({ profile: 48 });
    expect(metadata?.omittedIdsPreview).toEqual([
      "profile:filler:52",
      "profile:filler:53",
      "profile:filler:54",
      "profile:filler:55",
      "profile:filler:56",
      "profile:filler:57",
      "profile:filler:58",
      "profile:filler:59",
      "profile:filler:60",
      "profile:filler:61",
      "profile:filler:62",
      "profile:filler:63",
    ]);
    expect(metadata?.note).toContain(
      `kept ${LEVEL_ONE_EVIDENCE_ITEM_LIMIT} of 112 grounding evidence items`,
    );
    expect(metadata?.note).toContain("profile=48");
    // The disclosure stays inspectable without leaking evidence prose.
    expect(metadata?.note).not.toContain("Northwind");
    expect(metadata?.note).not.toContain(resumeText);

    // Compaction is deterministic across repeated requests.
    const compactedAgain = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 40_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });
    expect(JSON.stringify(compactedAgain)).toBe(JSON.stringify(compacted));
  });

  test("reserves original-resume and core-skill anchors when more than 64 experience items compete for level-one slots", () => {
    const resumeText = buildLongResumeText();
    const experienceRoles = 13;
    const experienceFlood: GroundingEvidenceItem[] = [];
    for (let role = 0; role < experienceRoles; role += 1) {
      const recordId = `exp_role_${role}`;
      experienceFlood.push(
        {
          id: `experience:${recordId}:summary`,
          text: `Role ${role} summary: delivered platform work for enterprise operations teams.`,
          scope: "experience",
          profileRecordId: recordId,
        },
        {
          id: `experience:${recordId}:achievement:0`,
          text: `Role ${role} achievement one: improved delivery throughput measurably.`,
          scope: "experience",
          profileRecordId: recordId,
        },
        {
          id: `experience:${recordId}:achievement:1`,
          text: `Role ${role} achievement two: reduced operational toil across teams.`,
          scope: "experience",
          profileRecordId: recordId,
        },
        {
          id: `experience:${recordId}:skills`,
          text: "TypeScript, Kafka",
          scope: "experience",
          profileRecordId: recordId,
        },
        {
          id: `experience:${recordId}:domainTags`,
          text: "platform, payments, reliability",
          scope: "experience",
          profileRecordId: recordId,
        },
      );
    }

    const userPayload: Record<string, unknown> = {
      baseResumeText: resumeText,
      targetJob: buildTargetJob(),
      groundingEvidence: {
        version: 1,
        items: [
          {
            id: "profile:skills",
            text: "TypeScript, Kafka, Kubernetes, PostgreSQL, Terraform",
            scope: "profile",
            profileRecordId: null,
          },
          {
            id: "profile:skillGroup:coreSkills",
            text: "Distributed systems, event-driven architecture, developer platforms",
            scope: "profile",
            profileRecordId: null,
          },
          ...Array.from({ length: 60 }, (_, index) =>
            buildProfileFillerItem(index),
          ),
          ...experienceFlood,
          {
            id: "project:proj_orion:summary",
            text: "Orion: open-source workflow orchestrator adopted by three Fortune 500 logistics teams.",
            scope: "project",
            profileRecordId: "proj_orion",
          },
          {
            id: "project:proj_orion:outcome",
            text: "Grew Orion to 2.4k GitHub stars and a 40-contributor community.",
            scope: "project",
            profileRecordId: "proj_orion",
          },
          {
            id: "proof:proof_northwind:claim",
            text: "Named primary inventor on the Northwind streaming ingestion patent filing.",
            scope: "proof",
            profileRecordId: "proof_northwind",
          },
          {
            id: "proof:proof_northwind:heroMetric",
            text: "41% checkout p95 latency reduction verified by APM traces.",
            scope: "proof",
            profileRecordId: "proof_northwind",
          },
          {
            id: "importEvidence:summary:0",
            text: "Imported summary evidence describing reliability engineering ownership.",
            scope: "import_evidence",
            profileRecordId: null,
          },
          {
            id: "importEvidence:skills",
            text: "TypeScript, Kafka, Terraform",
            scope: "import_evidence",
            profileRecordId: null,
          },
          {
            id: "baseResume:text",
            text: resumeText,
            scope: "import_evidence",
            profileRecordId: null,
          },
        ],
      },
    };

    const compacted = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 34_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });

    expect(ResumeImportJsonValueSchema.safeParse(compacted).success).toBe(true);

    const grounded = compacted as unknown as GroundedResumePayload;
    const items = grounded.groundingEvidence?.items ?? [];

    // Reserved anchors survive the experience flood.
    expect(items.map((item) => item.id)).toContain("baseResume:text");
    expect(items.map((item) => item.id)).toContain("profile:skills");
    expect(items.map((item) => item.id)).toContain(
      "profile:skillGroup:coreSkills",
    );
    expect(items[0]?.id).toBe("baseResume:text");
    expect(items[1]?.id).toBe("profile:skills");
    expect(items[2]?.id).toBe("profile:skillGroup:coreSkills");

    // Representative project, proof, and imported-resume context survives.
    const keptIds = items.map((item) => item.id);
    expect(keptIds).toContain("project:proj_orion:summary");
    expect(keptIds).toContain("proof:proof_northwind:claim");
    expect(keptIds).toContain("importEvidence:summary:0");

    // Role facts are not starved: most experience items stay, led by
    // summaries and achievements rather than redundant domain tags.
    const keptExperience = items.filter((item) => item.scope === "experience");
    expect(keptExperience).toHaveLength(58);
    expect(keptIds).toContain("experience:exp_role_0:summary");
    expect(keptIds).toContain("experience:exp_role_12:summary");
    expect(
      keptExperience
        .filter((item) => (item.id ?? "").endsWith(":domainTags"))
        .map((item) => item.id),
    ).toEqual([
      "experience:exp_role_0:domainTags",
      "experience:exp_role_1:domainTags",
      "experience:exp_role_2:domainTags",
      "experience:exp_role_3:domainTags",
      "experience:exp_role_4:domainTags",
      "experience:exp_role_5:domainTags",
    ]);

    // Generic profile fillers are the lowest-value items and all omit.
    expect(keptIds.some((id) => (id ?? "").startsWith("profile:filler:"))).toBe(
      false,
    );

    const metadata = grounded.groundingEvidence?.compaction;
    expect(metadata?.applied).toBe(true);
    expect(metadata?.originalItemCount).toBe(134);
    expect(metadata?.includedItemCount).toBe(LEVEL_ONE_EVIDENCE_ITEM_LIMIT);
    expect(metadata?.omittedItemCount).toBe(70);
    expect(metadata?.omittedScopeCounts).toEqual({
      experience: 7,
      import_evidence: 1,
      profile: 60,
      project: 1,
      proof: 1,
    });
    expect(metadata?.omittedIdsPreview).toEqual([
      "profile:filler:0",
      "profile:filler:1",
      "profile:filler:2",
      "profile:filler:3",
      "profile:filler:4",
      "profile:filler:5",
      "profile:filler:6",
      "profile:filler:7",
      "profile:filler:8",
      "profile:filler:9",
      "profile:filler:10",
      "profile:filler:11",
    ]);
    expect(metadata?.note).toContain("kept 64 of 134 grounding evidence items");

    // Compaction stays deterministic under anchor reservation.
    const compactedAgain = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 34_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });
    expect(JSON.stringify(compactedAgain)).toBe(JSON.stringify(compacted));
  });

  test("bounds pathological omitted evidence ids so compaction metadata never exceeds the model input budget", () => {
    const bloatedIdSuffix = "x".repeat(6_000);
    const userPayload: Record<string, unknown> = {
      baseResumeText: "Compact base resume text for the bloat scenario.",
      targetJob: buildTargetJob(),
      groundingEvidence: {
        version: 1,
        items: [
          {
            id: "profile:skills",
            text: "TypeScript, Kafka, Kubernetes",
            scope: "profile",
            profileRecordId: null,
          },
          ...Array.from({ length: 70 }, (_, index) => ({
            id: `profile:bloat:${index}:${bloatedIdSuffix}`,
            text: "Bloat filler evidence entry.",
            scope: "profile",
            profileRecordId: null,
          })),
          {
            id: "baseResume:text",
            text: "Compact base resume text for the bloat scenario.",
            scope: "import_evidence",
            profileRecordId: null,
          },
        ],
      },
    };

    const compacted = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 30_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });

    expect(ResumeImportJsonValueSchema.safeParse(compacted).success).toBe(true);

    const grounded = compacted as unknown as GroundedResumePayload;
    const metadata = grounded.groundingEvidence?.compaction;

    expect(metadata?.applied).toBe(true);
    expect(metadata?.originalItemCount).toBe(72);
    expect(metadata?.includedItemCount).toBe(LEVEL_ONE_EVIDENCE_ITEM_LIMIT);
    expect(metadata?.omittedItemCount).toBe(8);
    expect(metadata?.omittedScopeCounts).toEqual({ profile: 8 });

    // Every disclosed id is bounded to the fixed safe length before sizing.
    const preview = metadata?.omittedIdsPreview ?? [];
    expect(preview).toHaveLength(8);
    for (const id of preview) {
      expect(id.length).toBeLessThanOrEqual(BOUNDED_OMITTED_ID_CHARS);
      expect(id.endsWith("…")).toBe(true);
    }
    expect(preview[0]?.startsWith("profile:bloat:62:")).toBe(true);

    // No unbounded id content leaks into the note.
    const note = metadata?.note ?? "";
    expect(note.length).toBeLessThanOrEqual(1_500);
    expect(note.includes(bloatedIdSuffix)).toBe(false);
    expect(note.includes("x".repeat(300))).toBe(false);
    expect(note).toContain("kept 64 of 72 grounding evidence items");

    // Anchors survive even alongside pathological ids.
    const keptIds = (grounded.groundingEvidence?.items ?? []).map(
      (item) => item.id,
    );
    expect(keptIds).toContain("baseResume:text");
    expect(keptIds).toContain("profile:skills");

    // The full compacted payload remains within the model input budget.
    expect(JSON.stringify(compacted).length).toBeLessThanOrEqual(
      computeExpectedCharBudget(30_000),
    );

    // Metadata sizing stays deterministic across repeated requests.
    const compactedAgain = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 30_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });
    expect(JSON.stringify(compactedAgain)).toBe(JSON.stringify(compacted));
  });

  test("bounds an oversized baseResumeText within the long resume budget while disclosing the truncation inline", () => {
    const resumeText = buildVeryLongResumeText();
    const userPayload = buildGroundedResumePayload({
      resumeText,
      profileFillerCount: 20,
      shortFillers: true,
    });

    const compacted = compactOpenAiCompatibleUserPayload({
      operation: "createResumeDraft",
      modelContextWindowTokens: 30_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload,
    });

    expect(ResumeImportJsonValueSchema.safeParse(compacted).success).toBe(true);

    const grounded = compacted as unknown as GroundedResumePayload;
    const compactedResumeText = grounded.baseResumeText ?? "";

    expect(compactedResumeText).not.toBe(resumeText);
    expect(compactedResumeText.length).toBeLessThanOrEqual(28_010);
    expect(compactedResumeText).toContain("[truncated");
    expect(compactedResumeText).toContain("HEAD_SENTINEL");
    expect(compactedResumeText).toContain("TAIL_SENTINEL");
    expect(compactedResumeText.startsWith(resumeText.slice(0, 60))).toBe(true);
    expect(compactedResumeText.endsWith(resumeText.slice(-60))).toBe(true);

    // Every evidence item still fits, so nothing was omitted and no
    // omission metadata is emitted.
    expect(grounded.groundingEvidence?.items).toHaveLength(32);
    expect(grounded.groundingEvidence?.compaction).toBeUndefined();
  });

  test("sends every job, claim and evidence entry of a pre-sized call that fits", () => {
    const jobs = Array.from({ length: 20 }, (_, index) => ({
      jobId: `job_${index + 1}`,
      title: `Role ${index + 1}`,
    }));
    const judged = compactOpenAiCompatibleUserPayload({
      operation: "judgeJobFits",
      modelContextWindowTokens: 128_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload: { jobs },
    }) as { jobs: unknown[] };
    expect(judged.jobs).toHaveLength(20);

    const evidence = Array.from({ length: 42 }, (_, index) => ({
      id: `evidence_${index + 1}`,
      text: `Saved fact ${index + 1}.`,
    }));
    const claims = Array.from({ length: 30 }, (_, index) => ({
      id: `line_${index + 1}`,
      text: `Resume line ${index + 1}.`,
    }));
    const checked = compactOpenAiCompatibleUserPayload({
      operation: "checkResumeClaims",
      modelContextWindowTokens: 128_000,
      systemPrompt: SYSTEM_PROMPT,
      userPayload: { evidence, claims },
    }) as { evidence: unknown[]; claims: unknown[] };
    expect(checked.evidence).toHaveLength(42);
    expect(checked.claims).toHaveLength(30);
  });
});

describe("full fit evidence", () => {
  test("keeps a middle requirement and all qualification entries when within budget", () => {
    const payload = {
      profile: {
        baseResume: {
          textContent: "Full imported resume evidence ".repeat(1500),
        },
      },
      job: {
        description:
          "a".repeat(10000) +
          "Java and Dutch C1 are required" +
          "z".repeat(10000),
        minimumQualifications: Array.from(
          { length: 20 },
          (_, i) => `Requirement ${i}`,
        ),
      },
    };
    expect(
      compactOpenAiCompatibleUserPayload({
        operation: "assessJobFit",
        modelContextWindowTokens: 196000,
        systemPrompt: "Read the full listing",
        userPayload: payload,
      }),
    ).toEqual(payload);
  });
  test("reports an oversized full read instead of silently omitting evidence", () => {
    expect(() =>
      compactOpenAiCompatibleUserPayload({
        operation: "assessJobFit",
        modelContextWindowTokens: 16000,
        systemPrompt: "Read the full listing",
        userPayload: { job: { description: "requirement ".repeat(10000) } },
      }),
    ).toThrow("exceed the model's input limit");
  });
});

describe("full resume context", () => {
  test("preserves long listing text and every evidence item when the complete request fits", () => {
    const payload = {
      targetJob: {
        description: "Listing paragraph. ".repeat(1_000),
        minimumQualifications: Array.from(
          { length: 25 },
          (_, index) => `Requirement ${index}`,
        ),
      },
      groundingEvidence: {
        items: Array.from({ length: 80 }, (_, index) => ({
          id: `evidence_${index}`,
          text: `Saved fact ${index}`,
        })),
      },
    };
    expect(
      compactOpenAiCompatibleUserPayload({
        operation: "createResumeDraft",
        modelContextWindowTokens: 196_000,
        systemPrompt: SYSTEM_PROMPT,
        userPayload: payload,
        preserveFullPayload: true,
      }),
    ).toEqual(payload);
  });

  test("rejects an oversized resume request instead of silently truncating candidate or listing evidence", () => {
    expect(() =>
      compactOpenAiCompatibleUserPayload({
        operation: "createResumeDraft",
        modelContextWindowTokens: 16_000,
        systemPrompt: SYSTEM_PROMPT,
        userPayload: {
          targetJob: { description: "Required experience. ".repeat(10_000) },
        },
        preserveFullPayload: true,
      }),
    ).toThrow("no candidate facts or listing details were omitted");
  });
});
