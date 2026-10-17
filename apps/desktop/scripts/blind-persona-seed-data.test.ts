import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DiscoveryJobViewSchema,
  JobFinderRepositoryStateSchema,
  SavedJobDiscoveryProvenanceSchema,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import { deriveSourceAccessPrompts } from "../../../packages/job-finder/src/internal/workspace-source-access-prompts";
import { describe, expect, it } from "vitest";

import {
  buildBlindPersonaRepositoryStates,
  calculateBlindPersonaDigest,
  calculateBlindPersonaStateDigest,
  loadBlindPersonaSeedData,
  stableBlindPersonaSerialization,
} from "./blind-persona-seed-data";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CANONICAL_MATRIX = [
  {
    id: "P01",
    workspace: "fresh",
    resume: "first-job.txt",
    role: /store|library/iu,
  },
  {
    id: "P02",
    workspace: "fresh",
    resume: "junior-developer.txt",
    role: /developer|qa/iu,
  },
  {
    id: "P03",
    workspace: "fresh",
    resume: "experienced-technical.txt",
    role: /frontend|ui platform/iu,
  },
  {
    id: "P04",
    workspace: "fresh",
    resume: "logistics-transition.txt",
    role: /logistics|dispatch/iu,
  },
  {
    id: "P05",
    workspace: "fresh",
    resume: "laid-off-manager.txt",
    role: /operations|program manager/iu,
  },
  {
    id: "P06",
    workspace: "fresh",
    resume: "returning-parent.txt",
    role: /part-time|scheduling/iu,
  },
  {
    id: "P07",
    workspace: "fresh",
    resume: "older-nontechnical.txt",
    role: /store lead|sales associate/iu,
  },
  {
    id: "P08",
    workspace: "fresh",
    resume: "hospitality-support.txt",
    role: /support/iu,
  },
  {
    id: "P09",
    workspace: "fresh",
    resume: "healthcare-admin.txt",
    role: /healthcare|patient records/iu,
  },
  {
    id: "P10",
    workspace: "fresh",
    resume: "employment-gap.txt",
    role: /bookkeeping|office administrative/iu,
  },
  {
    id: "P11",
    workspace: "fresh",
    resume: "remote-qa-support.txt",
    role: /qa|support/iu,
  },
  {
    id: "P12",
    workspace: "fresh",
    resume: "payroll-admin.txt",
    role: /payroll|office administrator/iu,
  },
  {
    id: "P13",
    workspace: "declarative_overlay",
    resume: "marketing-manager.txt",
    role: /marketing/iu,
  },
  {
    id: "P14",
    workspace: "declarative_overlay",
    resume: "service-manager.txt",
    role: /service/iu,
  },
] as const;

const EXPECTED_CORPUS_BINDINGS = {
  P01: {
    matchJobId: "blind_p01_store_assistant",
    weakerJobId: "blind_p01_library_page",
  },
  P02: {
    matchJobId: "blind_p02_junior_web",
    weakerJobId: "blind_p02_qa_automation",
  },
  P03: {
    matchJobId: "blind_p03_frontend",
    weakerJobId: "blind_p03_design_system",
  },
  P04: {
    matchJobId: "blind_p04_logistics_admin",
    weakerJobId: "blind_p04_dispatch_admin",
  },
  P05: {
    matchJobId: "blind_p05_ops_manager",
    weakerJobId: "blind_p05_program",
  },
  P06: {
    matchJobId: "blind_p06_part_time_admin",
    weakerJobId: "blind_p06_remote_scheduler",
  },
  P07: {
    matchJobId: "blind_p07_part_time_lead",
    weakerJobId: "blind_p07_sales_associate",
  },
  P08: {
    matchJobId: "blind_p08_support",
    weakerJobId: "blind_p08_bilingual",
  },
  P09: {
    matchJobId: "blind_p09_healthcare_admin",
    weakerJobId: "blind_p09_records_coordinator",
  },
  P10: {
    matchJobId: "blind_p10_bookkeeping",
    weakerJobId: "blind_p10_office_admin",
  },
  P11: {
    matchJobId: "blind_p11_remote_qa",
    weakerJobId: "blind_p11_remote_support",
  },
  P12: {
    matchJobId: "blind_p12_payroll",
    weakerJobId: "blind_p12_office_admin",
  },
} as const;

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectStrings);
  }
  return [];
}

function includesKeyword(values: string[], keywords: string[]): boolean {
  const normalized = values.join(" ").toLowerCase();
  return keywords.some((keyword) =>
    normalized.includes(keyword.toLowerCase().trim()),
  );
}

function collectEntries(
  value: unknown,
  pathParts: string[] = [],
): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      collectEntries(entry, [...pathParts, String(index)]),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => [
      { path: [...pathParts, key].join("."), value: entry },
      ...collectEntries(entry, [...pathParts, key]),
    ]);
  }
  return [];
}

describe("blind persona deterministic seed data", () => {
  it("locks the canonical P01-P14 workspace, resume, role, setup, input, and zoom matrix", async () => {
    const { jobsByPersona, manifest } = await loadBlindPersonaSeedData();

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.sessions).toHaveLength(CANONICAL_MATRIX.length);
    for (const [index, expected] of CANONICAL_MATRIX.entries()) {
      const session = manifest.sessions[index]!;
      expect(session.id).toBe(`blind-persona-v1/${expected.id}`);
      expect(session.workspace.kind).toBe(expected.workspace);
      expect(path.basename(session.resumeInput.path)).toBe(expected.resume);
      if (expected.id <= "P12") {
        expect(session.workspace.profileSetup).toEqual({
          status: "not_started",
          currentStep: "import",
        });
        expect(session.resumeInput.importRequired).toBe(true);
        expect(
          jobsByPersona[expected.id]?.every((job) =>
            expected.role.test(job.title),
          ),
        ).toBe(true);
      } else {
        expect(session.workspace.profileSetup.status).toBe("materialized");
        expect(session.resumeInput.importRequired).toBe(false);
      }
    }
    expect(
      new Set(manifest.sessions.map((session) => session.brief)).size,
    ).toBe(14);
    expect(new Set(manifest.sessions.map((session) => session.goal)).size).toBe(
      14,
    );
  });

  it("keeps tester-facing persona text free of test-design, driver, and implementation vocabulary", async () => {
    // brief/context/goal/outcome are the only fields a future tester reads.
    // Every driver concern below is enforced mechanically elsewhere in this
    // suite (viewport, sessionProtocol, jobState, expectedAuthority), so the
    // tester-facing prose must stand on its own as ordinary life context.
    const testerFacingForbidden: ReadonlyArray<{
      pattern: RegExp;
      reason: string;
    }> = [
      { pattern: /\btest(?:s|ing|ed|er|ers)?\b/iu, reason: "test activity" },
      {
        pattern:
          /\bfixtures?\b|\bcorpus\b|\bcorpora\b|\b(?:re)?seeds?(?:ed|ing)?\b|\bmanifest\b|\bharness\b/iu,
        reason: "fixture and harness vocabulary",
      },
      {
        pattern: /\bblind\s+personas?\b|\bpersonas?\b|\bcohort(?:s)?\b/iu,
        reason: "persona/cohort design vocabulary",
      },
      {
        pattern: /\belectron\b|\bCDP\b|\bdevtools\b/iu,
        reason: "Electron/CDP runtime vocabulary",
      },
      {
        pattern:
          /\bzoom\b|nativeZoomFactor|native_\d+_percent|\b\d{2,3}\s*percent\s+zoom\b|\b(?:1280|1440|720|920)\b/iu,
        reason: "zoom/viewport driver metadata",
      },
      {
        pattern:
          /\bdeterministic\b|\bpersist(?:ed|ence|ent)\b|\bmaterializ|\boverlay\b|\bdeclarative\b/iu,
        reason: "workspace state internals",
      },
      {
        pattern: /\bbatches?\b/iu,
        reason: "bulk-review safeguard vocabulary",
      },
      {
        pattern:
          /\bunannounced\b|\binterruption\b|\binterrupt(?:ed|s|ing)?\b|\brecover(?:y|ies|ed|ing|s|able)?\b|\bresumable\b|\bcheckpoint\b/iu,
        reason: "session-protocol mechanics",
      },
      {
        pattern:
          /\bfacilitator\b|\broute\s+hints?\b|\bprocedure\s+hints?\b|\bpointer\s+input\b/iu,
        reason: "facilitation/driver input vocabulary",
      },
      {
        pattern:
          /\bsessionProtocol\b|\bexpectedAuthority\b|\bjobState\b|\bresumeInput\b|\bviewport\b/iu,
        reason: "manifest field names",
      },
      {
        pattern: /\buser-owned\b/iu,
        reason: "authority ownership label",
      },
      {
        pattern: /\bexternal[-\s]writes?\b/iu,
        reason: "privacy-receipt write-boundary vocabulary",
      },
      {
        pattern: /\bvisible\s+(?:\w+\s+)?resumes?\b/iu,
        reason: "resume presentation metadata",
      },
      {
        pattern: /\b1[,]?200\b|\b140\b|\b48\b/iu,
        reason: "deterministic fixture counts",
      },
    ];

    const { manifest } = await loadBlindPersonaSeedData();
    const testerFacingFields = ["brief", "context", "goal", "outcome"] as const;

    for (const session of manifest.sessions) {
      for (const field of testerFacingFields) {
        const text = session[field];
        for (const { pattern, reason } of testerFacingForbidden) {
          expect(
            pattern.test(text),
            `${session.id} ${field} leaks ${reason}: ${JSON.stringify(text)}`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps persona context in third-person life voice instead of operator instructions", async () => {
    // Tone itself cannot be proven by regex without brittle prose policing,
    // so this contract targets only the two mechanical shapes the hardening
    // review caught: a context opening with an imperative addressed to
    // whoever runs the session ("Treat...", "Keep...", "Use...") and an
    // embedded negative command mid-sentence ("; do not rewrite ...").
    // Neither shape occurs in genuine life narrative, which keeps false
    // positives away; subtler drift still relies on reviewing the exact
    // asserted texts in this suite.
    const { manifest } = await loadBlindPersonaSeedData();
    const imperativeOpeners =
      /^(?:Treat|Keep|Use|State|Distinguish|Avoid|Ensure|Make\s+sure|Do\s+not|Don't)\b/u;
    const negativeCommands = /\b(?:do\s+not|don't|never)\b/iu;

    for (const session of manifest.sessions) {
      expect(
        imperativeOpeners.test(session.context),
        `${session.id} context opens like an operator instruction: ${JSON.stringify(session.context)}`,
      ).toBe(false);
      expect(
        negativeCommands.test(session.context),
        `${session.id} context embeds a negative command: ${JSON.stringify(session.context)}`,
      ).toBe(false);
    }
  });

  it("resolves every visible resume input and keeps starter sources and authority disabled", async () => {
    const { assetPaths, manifest } = await loadBlindPersonaSeedData();

    for (const session of manifest.sessions) {
      expect(session.resumeInput.presentation).toBe(
        "visible_user_input_artifact",
      );
      expect(session.workspace.starterSources).toBe("disabled");
      expect(Object.values(session.expectedAuthority)).toEqual([
        false,
        false,
        false,
        false,
        false,
      ]);
      expect(session.input.procedureHintsAllowed).toBe(false);
      expect(session.viewport.width).toBeGreaterThanOrEqual(1280);
      expect(session.viewport.height).toBeGreaterThanOrEqual(720);
    }

    const p06 = manifest.sessions[5]!;
    const p09 = manifest.sessions[8]!;
    const p11 = manifest.sessions[10]!;
    const p12 = manifest.sessions[11]!;
    expect(p06.workspace.kind).toBe("fresh");
    expect(p06.sessionProtocol).toMatchObject({
      durationMinutes: 25,
      interruption: "once_during_active_session",
    });
    expect(p09.resumeInput.applicationMode).toBe("original_resume_unchanged");
    expect(p09.sessionProtocol.privacy).toBe(
      "minimum_disclosure_original_resume_unchanged",
    );
    expect(p11.input.mode).toBe("keyboard_only");
    expect(p11.viewport.nativeZoomFactor).toBe(1);
    expect(p12.workspace.kind).toBe("fresh");
    expect(p12.cohorts).toContain("native_125_percent");
    expect(p12.viewport).toMatchObject({
      width: 1280,
      height: 720,
      zoom: "native_125_percent",
      nativeZoomFactor: 1.25,
    });
    expect(
      manifest.sessions.filter(
        (session) => session.viewport.zoom !== "native_100_percent",
      ),
    ).toEqual([p12]);
    for (const assetPath of assetPaths) {
      expect(
        (await readFile(path.join(desktopRoot, assetPath), "utf8")).length,
      ).toBeGreaterThan(40);
    }
  });

  it("keeps resume and corpus language aligned with each canonical role", async () => {
    const { jobsByPersona, manifest } = await loadBlindPersonaSeedData();
    const resumeText = await Promise.all(
      manifest.sessions.map((session) =>
        readFile(path.join(desktopRoot, session.resumeInput.path), "utf8"),
      ),
    );

    expect(resumeText[0]).toMatch(/high school|volunteer/iu);
    expect(resumeText[1]).toMatch(/bootcamp[\s\S]*internship/iu);
    expect(resumeText[2]).toMatch(/15 years/iu);
    expect(resumeText[3]).toMatch(/delivery driver[\s\S]*warehouse/iu);
    expect(resumeText[6]).toMatch(/retail supervisor[\s\S]*part-time/iu);
    expect(resumeText[7]).toMatch(/front desk[\s\S]*B1 intermediate/iu);
    expect(resumeText[8]).toMatch(/healthcare administrative/iu);
    expect(resumeText[9]).toMatch(/employment gap[\s\S]*bookkeeping/iu);
    expect(resumeText[10]).toMatch(/QA and customer support/iu);
    expect(resumeText[11]).toMatch(/payroll and office administrator/iu);
    expect(resumeText[12]).toMatch(/marketing manager/iu);
    expect(resumeText[13]).toMatch(/service manager/iu);
    expect(collectStrings(jobsByPersona.P08).join(" ")).not.toMatch(
      /fluent English/iu,
    );
    expect(collectStrings(jobsByPersona.P04).join(" ")).not.toMatch(
      /maintenance|electrical|trade qualification/iu,
    );
  });

  it("parses fixed P01-P12 jobs through SavedJobSchema with source-generic test URLs", async () => {
    const { jobsByPersona, manifest } = await loadBlindPersonaSeedData();
    expect(Object.keys(jobsByPersona)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `P${String(index + 1).padStart(2, "0")}`,
      ),
    );

    const jobs = Object.values(jobsByPersona).flat();
    expect(jobs).toHaveLength(24);
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.discoveredAt).toBe(manifest.fixedTimestamp);
      expect(job.postedAt).toBe(manifest.fixedTimestamp);
      expect(job.source).toBe("target_site");
      for (const url of [
        job.canonicalUrl,
        job.applicationUrl,
        job.employerWebsiteUrl,
      ]) {
        if (url !== null)
          expect(new URL(url).hostname.endsWith(".test")).toBe(true);
      }
    }
  });

  it("binds each fresh persona to one two-job corpus with relevance dimensions and a weaker example", async () => {
    const { corpusBindings, jobsByCorpus, jobsByPersona, manifest } =
      await loadBlindPersonaSeedData();
    const expectedCorpusKeys = Object.keys(EXPECTED_CORPUS_BINDINGS);
    const freshSessions = manifest.sessions.filter(
      (session) => session.workspace.kind === "fresh",
    );
    const boundCorpusKeys = freshSessions.map(
      (session) => session.workspace.jobState.corpusKey,
    );

    expect(boundCorpusKeys).toEqual(expectedCorpusKeys);
    expect(new Set(boundCorpusKeys).size).toBe(expectedCorpusKeys.length);
    expect(Object.keys(corpusBindings).sort()).toEqual(
      [...expectedCorpusKeys].sort(),
    );

    for (const corpusKey of expectedCorpusKeys) {
      const expected =
        EXPECTED_CORPUS_BINDINGS[
          corpusKey as keyof typeof EXPECTED_CORPUS_BINDINGS
        ];
      const binding = corpusBindings[corpusKey];
      const jobs = jobsByCorpus[corpusKey];
      expect(binding).toMatchObject(expected);
      expect(jobs).toHaveLength(2);
      if (!binding || !jobs) continue;

      const match = jobs.find((job) => job.id === binding.matchJobId);
      const weaker = jobs.find((job) => job.id === binding.weakerJobId);
      expect(match).toBeDefined();
      expect(weaker).toBeDefined();
      if (!match || !weaker) continue;

      expect(
        includesKeyword(
          [match.title, match.description, ...match.keySkills],
          binding.matchCriteria.roleKeywords,
        ),
      ).toBe(true);
      expect(
        includesKeyword(
          [match.location],
          binding.matchCriteria.locationKeywords,
        ),
      ).toBe(true);
      expect(
        match.workMode.some((mode) =>
          binding.matchCriteria.workModes.includes(mode),
        ),
      ).toBe(true);
      expect(weaker.matchAssessment.gaps.length).toBeGreaterThan(0);
      expect(weaker.matchAssessment.score).toBeLessThan(
        match.matchAssessment.score,
      );
    }

    expect(Object.values(jobsByPersona).flat()).toHaveLength(24);
  });

  it("keeps fixed corpora offline, activity-unknown, provisional, and unbound", async () => {
    const { jobsByCorpus } = await loadBlindPersonaSeedData();

    for (const job of Object.values(jobsByCorpus).flat()) {
      expect(job.status).toBe("discovered");
      expect(job.discoveryMethod).toBe("catalog_seed");
      expect(job.provenance).toEqual([]);
      expect(job.firstSeenAt).toBeNull();
      expect(job.lastSeenAt).toBeNull();
      expect(job.lastVerifiedActiveAt).toBeNull();
      expect(job.providerUpdatedAt).toBeNull();
      expect(job.matchAssessment.contextFingerprint).toBeNull();
      expect(job.matchAssessment.postingFingerprint).toBeNull();
      expect(job.discoveryFeedback).toBeNull();
      expect(job.resumeApplicationMode).toBeNull();
      expect(job.latestMatchAssessmentAudit).toBeNull();
      expect(job.sourceIntelligence).toBeNull();
      expect(job.providerKey).toBeNull();
      expect(job.providerBoardToken).toBeNull();
      expect(job.providerIdentifier).toBeNull();
      expect("listingActivity" in job).toBe(false);
      expect(DiscoveryJobViewSchema.parse(job).listingActivity).toEqual({
        status: "unknown",
      });
    }
  });

  it("contains no live URL or email domains in any referenced asset", async () => {
    const { assetPaths, manifest } = await loadBlindPersonaSeedData();
    for (const assetPath of assetPaths) {
      const content = await readFile(path.join(desktopRoot, assetPath), "utf8");
      const urls = content.match(/https?:\/\/[^\s"']+/gu) ?? [];
      const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/giu) ?? [];
      for (const url of urls)
        expect(new URL(url).hostname.endsWith(".test")).toBe(true);
      for (const email of emails)
        expect(email.toLowerCase().endsWith(".test")).toBe(true);
    }
    for (const value of collectStrings(manifest)) {
      if (/^https?:\/\//u.test(value))
        expect(new URL(value).hostname.endsWith(".test")).toBe(true);
    }
  });

  it("keeps P13 and P14 phase-one state composition explicit", async () => {
    const { manifest } = await loadBlindPersonaSeedData();
    const p13 = manifest.sessions[12]!;
    const p14 = manifest.sessions[13]!;

    expect(p13.workspace.kind).toBe("declarative_overlay");
    expect(p13.workspace.jobState).toMatchObject({
      kind: "high_volume_overlay",
      baseCorpusKey: "P13_MARKETING",
      deterministicGeneratedJobCount: 1200,
      safeguardState: "batch_review_required",
    });
    expect(p14.workspace.kind).toBe("declarative_overlay");
    expect(p14.workspace.jobState).toMatchObject({
      kind: "interrupted_blocked_overlay",
      baseCorpusKey: "P14_SERVICE_MANAGER",
      retainedResultCount: 0,
      blocker: "site_login_required",
    });
  });

  it("reproduces the stored canonical manifest and asset digest", async () => {
    const first = await loadBlindPersonaSeedData();
    const second = await calculateBlindPersonaDigest(first.manifest);

    expect(first.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.digestSha256).toBe(first.digestSha256);
    expect(first.manifest.digestSha256).toBe(first.digestSha256);
  });

  it("binds the final persona prompt while excluding the manifest self-digest", async () => {
    const { manifest, digestSha256 } = await loadBlindPersonaSeedData();
    const selfDigestChanged = await calculateBlindPersonaDigest({
      ...manifest,
      digestSha256: "0".repeat(64),
    });
    const promptChanged = await calculateBlindPersonaDigest({
      ...manifest,
      visualReviewTemplate: {
        ...manifest.visualReviewTemplate,
        prompt: `${manifest.visualReviewTemplate.prompt} Additional note.`,
      },
    });

    expect(selfDigestChanged.digestSha256).toBe(digestSha256);
    expect(promptChanged.digestSha256).not.toBe(digestSha256);
  });

  it("keeps visual criticism explicit about action geometry and painted layout defects", async () => {
    const { manifest } = await loadBlindPersonaSeedData();
    const prompt = manifest.visualReviewTemplate.prompt;
    const lenses = manifest.visualReviewTemplate.lenses;

    for (const phrase of [
      "action group",
      "accidental full-width",
      "consistent heights and gaps",
      "disabled reasons",
      "padding, margins, gutters",
      "keyboard/focus order",
      "painted clipping",
      "bottom or right-side actions",
      "POST-JOURNEY OPTIONAL CHECKPOINT",
    ]) {
      expect(prompt).toContain(phrase);
    }
    expect(lenses.firstStableViewport).toContain("above the fold");
    expect(lenses.hierarchyDensityAndStateChange).toContain("natural widths");
    expect(lenses.loadingState).toContain("waiting region");
    expect(lenses.brandAndNavigation).toContain("active state");
    expect(lenses.clippingAndOverlap).toContain("accidental overflow");
  });

  it("materializes P13 with exact scale counts, varied local CRM facts, and follow-up scenarios", async () => {
    const { manifest } = await loadBlindPersonaSeedData();
    const { P13 } = await buildBlindPersonaRepositoryStates();
    const overlay = manifest.sessions[12]!.workspace.jobState;

    expect(P13.savedJobs).toHaveLength(
      overlay.deterministicGeneratedJobCount as number,
    );
    expect(
      P13.savedJobs.filter((job) => job.status === "shortlisted"),
    ).toHaveLength(overlay.shortlistedCount as number);
    expect(P13.applicationRecords).toHaveLength(
      overlay.applicationRecordCount as number,
    );
    expect(new Set(P13.savedJobs.map((job) => job.id))).toHaveLength(1_200);
    expect(new Set(P13.savedJobs.map((job) => job.title)).size).toBeGreaterThan(
      5,
    );
    expect(new Set(P13.savedJobs.map((job) => job.company)).size).toBe(60);
    expect(new Set(P13.savedJobs.map((job) => job.location)).size).toBe(5);
    expect(P13.searchPreferences.discovery.targets).toHaveLength(1);
    expect(P13.searchPreferences.discovery.targets[0]?.enabled).toBe(false);
    expect(P13.profile.headline).toBe("Marketing manager");
    expect(
      P13.savedJobs.every((job) =>
        /marketing|campaign|growth|demand generation/iu.test(job.title),
      ),
    ).toBe(true);
    expect(P13.savedJobs.some((job) => /engineer/iu.test(job.title))).toBe(
      false,
    );

    const crmRecords = P13.applicationRecords.map((record) => record.crm!);
    expect(new Set(crmRecords.map((crm) => crm.stage)).size).toBe(12);
    expect(
      crmRecords.every((crm) =>
        crm.events.some(
          (event) => event.kind === "stage_changed" && event.source === "user",
        ),
      ),
    ).toBe(true);
    const reminders = crmRecords.flatMap((crm) => crm.reminders);
    expect(reminders).toHaveLength(48);
    expect(
      reminders.filter(
        (reminder) =>
          reminder.status === "pending" &&
          reminder.dueAt < manifest.fixedTimestamp,
      ),
    ).toHaveLength(12);
    expect(
      reminders.filter(
        (reminder) =>
          reminder.status === "pending" &&
          reminder.dueAt === manifest.fixedTimestamp,
      ),
    ).toHaveLength(12);
    expect(
      reminders.filter(
        (reminder) =>
          reminder.status === "pending" &&
          reminder.dueAt > manifest.fixedTimestamp,
      ),
    ).toHaveLength(12);
    expect(
      reminders.filter((reminder) => reminder.status === "completed"),
    ).toHaveLength(12);

    expect(P13.intelligence.outcomeEvents).toHaveLength(12);
    const applicationIds = new Set(
      P13.applicationRecords.map((record) => record.id),
    );
    for (const outcome of P13.intelligence.outcomeEvents) {
      expect(outcome.campaignId).toBe(P13.activeCampaignId);
      expect(applicationIds.has(outcome.applicationRecordId!)).toBe(true);
      expect(outcome.userControlled).toBe(true);
    }
    expect(
      P13.intelligence.safeguards.preparedBatchSampleReviews[0],
    ).toMatchObject({
      preparedCount: 48,
      sampleCount: 10,
      reviewedCount: 3,
      reviewCompleted: false,
    });
  });

  it("materializes P14 as recovered failed preparation with retained review lineage and one source blocker", async () => {
    const { P14 } = await buildBlindPersonaRepositoryStates();

    expect(P14.applyRuns).toHaveLength(1);
    expect(P14.profile.headline).toBe("Service manager");
    expect(P14.savedJobs[0]?.title).toBe("Service Operations Manager");
    expect(P14.applyRuns[0]).toMatchObject({
      mode: "copilot",
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
      detail:
        "The app closed before safe application preparation finished. No final submit action was taken, and any preparation saved before the interruption remains available for review.",
      submittedJobs: 0,
    });
    expect(P14.applyJobResults).toHaveLength(1);
    expect(P14.applyJobResults[0]).toMatchObject({
      state: "awaiting_review",
      applicationRecordId: P14.applicationRecords[0]?.id,
      privacyReceipt: {
        accountCreationAuthorized: false,
        finalSubmitAuthorized: false,
        finalSubmitOccurred: false,
      },
    });
    expect(P14.applyJobResults[0]?.privacyReceipt?.lineage).toEqual({
      runId: P14.applyRuns[0]?.id,
      jobId: P14.savedJobs[0]?.id,
      applicationRecordId: P14.applicationRecords[0]?.id,
      resultId: P14.applyJobResults[0]?.id,
    });
    expect(P14.applicationAttempts[0]).toMatchObject({
      jobId: P14.savedJobs[0]?.id,
      applicationRecordId: P14.applicationRecords[0]?.id,
      state: "paused",
      outcome: "ready_for_review",
    });

    expect(P14.userActionRequests).toHaveLength(1);
    expect(P14.userActionRequests[0]).toMatchObject({
      kind: "login",
      state: "pending",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      scope: {
        type: "discovery_source",
        targetId: "blind_p14_blocked_source",
        sourceDebugRunId: "blind_p14_source_debug_run",
      },
      verification: {
        type: "source_access",
        targetId: "blind_p14_blocked_source",
      },
    });
    expect(P14.userActionEvents).toHaveLength(1);
    expect(P14.discovery.runState).toBe("failed");
    expect(P14.discovery.activeRun).toBeNull();
    expect(P14.discovery.pendingDiscoveryJobs).toEqual([]);
    expect(P14.discovery.recentRuns).toHaveLength(1);
    expect(P14.discovery.recentRuns[0]).toMatchObject({
      state: "failed",
      summary: {
        validJobsFound: 0,
        jobsPersisted: 0,
        jobsStaged: 0,
        outcome: "failed",
      },
      targetExecutions: [
        {
          targetId: "blind_p14_blocked_source",
          state: "failed",
          jobsReviewed: 0,
          jobsFound: 0,
          jobsPersisted: 0,
          jobsStaged: 0,
        },
      ],
    });
  });

  it("links P14's blocked source run to the persisted sign-in prompt lineage", async () => {
    const { P14 } = await buildBlindPersonaRepositoryStates();
    const target = P14.searchPreferences.discovery.targets.find(
      (entry) => entry.id === "blind_p14_blocked_source",
    );
    const sourceDebugRun = P14.sourceDebugRuns.find(
      (run) => run.id === "blind_p14_source_debug_run",
    );

    if (!target || !sourceDebugRun) {
      throw new Error("Expected the P14 blocked source target and debug run.");
    }

    expect(target.lastDebugRunId).toBe(sourceDebugRun.id);
    expect(P14.discovery.activeSourceDebugRun).toEqual(sourceDebugRun);
    expect(P14.discovery.recentSourceDebugRuns).toEqual([sourceDebugRun]);

    const prompts = deriveSourceAccessPrompts({
      targets: P14.searchPreferences.discovery.targets,
      recentSourceDebugRuns: P14.discovery.recentSourceDebugRuns,
      activeSourceDebugRun: P14.discovery.activeSourceDebugRun,
      sourceDebugAttempts: P14.sourceDebugAttempts,
      sourceInstructionArtifacts: P14.sourceInstructionArtifacts,
      searchPreferences: P14.searchPreferences,
      generatedAt: "2026-08-28T00:00:00.000Z",
    });

    expect(prompts).toEqual([
      expect.objectContaining({
        targetId: target.id,
        state: "prompt_login_required",
        detail: sourceDebugRun.manualPrerequisiteSummary,
      }),
    ]);
  });

  it("resolves every seeded job's provenance to a configured discovery target", async () => {
    const { manifest } = await loadBlindPersonaSeedData();
    const states = await buildBlindPersonaRepositoryStates();
    const fixedAt = Date.parse(manifest.fixedTimestamp);

    expect(JobFinderRepositoryStateSchema.safeParse(states.P13).success).toBe(
      true,
    );
    expect(JobFinderRepositoryStateSchema.safeParse(states.P14).success).toBe(
      true,
    );

    const personaStates: Array<[string, JobFinderRepositoryState]> = [
      ["P13", states.P13],
      ["P14", states.P14],
    ];
    for (const [personaId, state] of personaStates) {
      const targetsById = new Map(
        state.searchPreferences.discovery.targets.map((target) => [
          target.id,
          target,
        ]),
      );
      expect(targetsById.size).toBeGreaterThan(0);

      for (const job of state.savedJobs) {
        // No blind persona models a legacy/imported unknown-source record, so
        // every seeded job must carry resolvable source provenance.
        expect(job.provenance.length).toBeGreaterThan(0);
        // Target-site fallback_search collection is browser_agent discovery;
        // the catalog_seed default would misstate how these roles arrived.
        expect(job.discoveryMethod).toBe("browser_agent");
        for (const entry of job.provenance) {
          expect(
            SavedJobDiscoveryProvenanceSchema.safeParse(entry).success,
          ).toBe(true);
          const target = targetsById.get(entry.targetId);
          expect(target).toBeDefined();
          if (!target) continue;
          expect(entry.startingUrl).toBe(target.startingUrl);
          expect(entry.adapterKind).toBe(target.adapterKind);
          expect(entry.resolvedAdapterKind).toBe(job.source);
          expect(entry.collectionMethod).toBe("fallback_search");
          expect(entry.discoveredAt).toBe(job.discoveredAt);
          expect(Date.parse(entry.discoveredAt)).lessThanOrEqual(fixedAt);
        }
      }
    }

    expect(
      new Set(
        states.P13.savedJobs.flatMap((job) =>
          job.provenance.map((entry) => entry.targetId),
        ),
      ),
    ).toEqual(new Set(["blind_p13_disabled_source"]));
    expect(states.P14.savedJobs[0]?.provenance).toHaveLength(1);
    expect(states.P14.savedJobs[0]?.provenance[0]).toMatchObject({
      targetId: "blind_p14_blocked_source",
      startingUrl: "https://blocked.jobs.example.test/openings",
      resolvedAdapterKind: "target_site",
    });
  });

  it("keeps materialized states isolated, synthetic, non-submitted, and unauthorized", async () => {
    const states = await buildBlindPersonaRepositoryStates();

    for (const state of Object.values(states)) {
      const entries = collectEntries(state);
      const pathValues = entries.filter(
        (entry) =>
          typeof entry.value === "string" &&
          /(?:^|\.)(?:storagePath|path)$/u.test(entry.path),
      );
      for (const entry of pathValues) {
        const value = entry.value as string;
        expect(path.isAbsolute(value)).toBe(false);
        expect(value).not.toMatch(/(?:^|[\\/])(?:tmp|temp)(?:[\\/]|$)/iu);
      }

      for (const value of collectStrings(state)) {
        if (/^https?:\/\//u.test(value)) {
          const url = new URL(value);
          expect(url.hostname.endsWith(".test")).toBe(true);
          expect(url.username).toBe("");
          expect(url.password).toBe("");
        }
        if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+$/iu.test(value)) {
          expect(value.toLowerCase().endsWith(".test")).toBe(true);
        }
      }

      for (const entry of entries) {
        if (
          /(?:submitAuthorized|finalSubmitAuthorized|accountCreationAuthorized|finalSubmitOccurred)$/u.test(
            entry.path,
          )
        ) {
          expect(entry.value).toBe(false);
        }
        if (/(?:^|\.)(?:state|status|outcome)$/u.test(entry.path)) {
          expect(entry.value).not.toBe("submitted");
        }
      }
      expect(state.applySubmitApprovals).toEqual([]);
    }
    expect(states.P13.profile.baseResume.storagePath).not.toBe(
      states.P14.profile.baseResume.storagePath,
    );
  });

  it("schema-validates and stably serializes deterministic P13/P14 states", async () => {
    const first = await buildBlindPersonaRepositoryStates();
    const second = await buildBlindPersonaRepositoryStates();

    expect(stableBlindPersonaSerialization(first.P13)).toBe(
      stableBlindPersonaSerialization(second.P13),
    );
    expect(stableBlindPersonaSerialization(first.P14)).toBe(
      stableBlindPersonaSerialization(second.P14),
    );
    expect(stableBlindPersonaSerialization(first.P13).length).toBeLessThan(
      5_000_000,
    );
    expect(stableBlindPersonaSerialization(first.P14).length).toBeLessThan(
      100_000,
    );
    // Pinned against the persisted-state schema of the day. A deliberate
    // contract change (a new persisted field, a new default) moves these; an
    // accidental change to the seed data moves them too, which is the point.
    // Regenerate both together, never one, and only alongside the schema
    // change that explains it.
    // Updated together for the 10,000-job retention default, uncapped scale
    // run budget, and background-check consent being enabled by default.
    expect(calculateBlindPersonaStateDigest(first.P13)).toBe(
      "09f5e712ac5a3901551f2531e81f7973938fdfb99483fe459d34576544c09586",
    );
    expect(calculateBlindPersonaStateDigest(first.P14)).toBe(
      "362df95b7c2f8173dafc9f8f6c399d86bc818ef712368b650d5b371ea44f62fb",
    );
    expect(calculateBlindPersonaStateDigest(first.P13)).toBe(
      calculateBlindPersonaStateDigest(second.P13),
    );
    expect(calculateBlindPersonaStateDigest(first.P14)).toBe(
      calculateBlindPersonaStateDigest(second.P14),
    );
  });
});
