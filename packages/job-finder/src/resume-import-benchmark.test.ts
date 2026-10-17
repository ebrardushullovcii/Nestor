import { describe, expect, test } from "vitest";

import { createResumeImportFixtureBundle } from "@nestor/ai-providers";
import {
  PROFILE_SETUP_PLACEHOLDER_HEADLINE,
  PROFILE_SETUP_PLACEHOLDER_SUMMARY,
} from "@nestor/contracts";

import {
  aggregateBenchmarkMetrics,
  buildCaseResult,
  runResumeImportBenchmark,
} from "./resume-import-benchmark";
import {
  createFreshStartSeedProfile,
  createSeed,
} from "./workspace-service.test-fixtures";

describe("resume import benchmark", () => {
  test("aggregates benchmark metrics across cases", () => {
    const metrics = aggregateBenchmarkMetrics([
      {
        caseId: "case_a",
        label: "Case A",
        parserStrategy: "embedded+plain_text",
        passed: true,
        taxonomy: [],
        notes: [],
        metrics: {
          literalFieldPrecision: 1,
          literalFieldRecall: 0.8,
          experienceRecordF1: 0.6,
          experienceDetailAccuracy: 0.8,
          educationRecordF1: 1,
          projectRecordF1: 1,
          certificationRecordF1: 1,
          languageRecordF1: 1,
          contradictionFreeRate: 1,
          evidenceCoverage: 0.9,
          autoApplyPrecision: 1,
          unresolvedRate: 0.2,
        },
      },
      {
        caseId: "case_b",
        label: "Case B",
        parserStrategy: "python_sidecar+local_docx",
        passed: true,
        taxonomy: [],
        notes: [],
        metrics: {
          literalFieldPrecision: 0.6,
          literalFieldRecall: 0.4,
          experienceRecordF1: 0.2,
          experienceDetailAccuracy: 0.4,
          educationRecordF1: 0.8,
          projectRecordF1: 0.6,
          certificationRecordF1: 0.8,
          languageRecordF1: 1,
          contradictionFreeRate: 0.5,
          evidenceCoverage: 0.7,
          autoApplyPrecision: 0.8,
          unresolvedRate: 0.5,
        },
      },
    ]);

    expect(metrics.literalFieldPrecision).toBeCloseTo(0.8);
    expect(metrics.literalFieldRecall).toBeCloseTo(0.6);
    expect(metrics.experienceRecordF1).toBeCloseTo(0.4);
    expect(metrics.experienceDetailAccuracy).toBeCloseTo(0.6);
    expect(metrics.projectRecordF1).toBeCloseTo(0.8);
    expect(metrics.contradictionFreeRate).toBeCloseTo(0.75);
    expect(metrics.unresolvedRate).toBeCloseTo(0.35);
  });

  test("runs a canary benchmark against fixture bundles", async () => {
    const seed = createSeed();
    const report = await runResumeImportBenchmark({
      request: {
        benchmarkVersion: "019-test-benchmark-v1",
        canaryOnly: true,
        useConfiguredAi: false,
        useVision: false,
        cases: [
          {
            id: "txt_canary",
            label: "TXT canary",
            resumePath:
              "apps/desktop/test-fixtures/job-finder/resume-import-sample.txt",
            canary: true,
            tags: ["txt"],
            expected: {
              literalFields: {
                fullName: "Jamie Rivers",
                currentLocation: "Berlin, Germany",
                email: "jamie@example.com",
                phone: "+49 555 0000000",
              },
              summaryContains: ["12 years of experience"],
              experienceRecords: [
                {
                  title: "Staff Frontend Engineer",
                  companyName: "Signal Systems",
                },
              ],
              educationRecords: [],
            },
          },
        ],
      },
      createHarness(benchmarkCase) {
        const bundle = createResumeImportFixtureBundle({
          id: benchmarkCase.id,
          parserManifestVersion: "019-plain-text-fixture-v1",
          pageTexts: [
            [
              "Jamie Rivers",
              "Staff Frontend Engineer",
              "Berlin, Germany",
              "jamie@example.com",
              "+49 555 0000000",
              "Summary",
              "Staff frontend engineer with 12 years of experience building React, TypeScript, and design system foundations for product teams.",
              "Experience",
              "Signal Systems",
              "Staff Frontend Engineer",
            ].join("\n"),
          ],
          blocks: [
            {
              id: "b1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Jamie Rivers",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l1"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b2",
              pageNumber: 1,
              readingOrder: 1,
              text: "Staff Frontend Engineer",
              kind: "paragraph",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l2"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b3",
              pageNumber: 1,
              readingOrder: 2,
              text: "Berlin, Germany",
              kind: "contact",
              sectionHint: "contact",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l3"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b4",
              pageNumber: 1,
              readingOrder: 3,
              text: "jamie@example.com",
              kind: "contact",
              sectionHint: "contact",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l4"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b5",
              pageNumber: 1,
              readingOrder: 4,
              text: "+49 555 0000000",
              kind: "contact",
              sectionHint: "contact",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l5"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b6",
              pageNumber: 1,
              readingOrder: 5,
              text: "Summary",
              kind: "heading",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l6"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b7",
              pageNumber: 1,
              readingOrder: 6,
              text: "Staff frontend engineer with 12 years of experience building React, TypeScript, and design system foundations for product teams.",
              kind: "paragraph",
              sectionHint: "summary",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l7"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b8",
              pageNumber: 1,
              readingOrder: 7,
              text: "Experience",
              kind: "heading",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l8"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b9",
              pageNumber: 1,
              readingOrder: 8,
              text: "Signal Systems",
              kind: "paragraph",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l9"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
            {
              id: "b10",
              pageNumber: 1,
              readingOrder: 9,
              text: "Staff Frontend Engineer",
              kind: "experience_header",
              sectionHint: "experience",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["l10"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
          ],
          parserKinds: ["plain_text"],
          routeKind: "plain_text_native",
          qualityScore: 0.98,
        });

        return Promise.resolve({
          profile: {
            ...createFreshStartSeedProfile(),
            // Legacy first-run strings the import is expected to replace.
            headline: PROFILE_SETUP_PLACEHOLDER_HEADLINE,
            summary: PROFILE_SETUP_PLACEHOLDER_SUMMARY,
            baseResume: {
              ...seed.profile.baseResume,
              id: `resume_${benchmarkCase.id}`,
              fileName: "resume-import-sample.txt",
              textContent: bundle.fullText,
              extractionStatus: "ready",
            },
            experiences: [],
            education: [],
            certifications: [],
            links: [],
            projects: [],
            spokenLanguages: [],
          },
          searchPreferences: seed.searchPreferences,
          documentBundle: bundle,
          aiClient: null,
          parseMethod: "fixture+plain_text",
          workerManifestVersion: bundle.parserManifest?.manifestVersion ?? null,
        });
      },
    });

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]?.passed).toBe(true);
    expect(report.aggregate.literalFieldRecall).toBeGreaterThan(0.75);
    expect(report.aggregate.autoApplyPrecision).toBe(1);
    expect(report.parserManifestVersion).toBe("019-plain-text-fixture-v1");
    expect(report.parserManifestVersions).toEqual([
      "019-plain-text-fixture-v1",
    ]);
  });

  test("reports mixed parser manifest versions instead of dropping the summary to null", async () => {
    const seed = createSeed();
    const report = await runResumeImportBenchmark({
      request: {
        benchmarkVersion: "019-test-benchmark-v1",
        canaryOnly: false,
        useConfiguredAi: false,
        useVision: false,
        cases: [
          {
            id: "case_a",
            label: "Case A",
            resumePath: "a.txt",
            canary: true,
            tags: ["txt"],
            expected: {
              literalFields: { fullName: "Jamie Rivers" },
              summaryContains: [],
              experienceRecords: [],
              educationRecords: [],
            },
          },
          {
            id: "case_b",
            label: "Case B",
            resumePath: "b.txt",
            canary: true,
            tags: ["txt"],
            expected: {
              literalFields: { fullName: "Jamie Rivers" },
              summaryContains: [],
              experienceRecords: [],
              educationRecords: [],
            },
          },
        ],
      },
      createHarness(benchmarkCase) {
        const bundle = createResumeImportFixtureBundle({
          id: benchmarkCase.id,
          parserManifestVersion:
            benchmarkCase.id === "case_a" ? "parser-a" : "parser-b",
          pageTexts: [["Jamie Rivers"].join("\n")],
          blocks: [
            {
              id: `block_${benchmarkCase.id}`,
              pageNumber: 1,
              readingOrder: 0,
              text: "Jamie Rivers",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: [`line_${benchmarkCase.id}`],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
          ],
          parserKinds: ["plain_text"],
          routeKind: "plain_text_native",
          qualityScore: 0.98,
        });

        return Promise.resolve({
          profile: {
            ...seed.profile,
            fullName: "Jamie Rivers",
            firstName: "Jamie",
            lastName: "Rivers",
            baseResume: {
              ...seed.profile.baseResume,
              id: `resume_${benchmarkCase.id}`,
              fileName: `${benchmarkCase.id}.txt`,
              textContent: bundle.fullText,
              extractionStatus: "ready",
            },
            experiences: [],
            education: [],
            certifications: [],
            links: [],
            projects: [],
            spokenLanguages: [],
          },
          searchPreferences: seed.searchPreferences,
          documentBundle: bundle,
          aiClient: null,
          parseMethod: "fixture+plain_text",
          workerManifestVersion: bundle.parserManifest?.manifestVersion ?? null,
        });
      },
    });

    expect(report.parserManifestVersion).toBe("mixed:parser-a,parser-b");
    expect(report.parserManifestVersions).toEqual(["parser-a", "parser-b"]);
  });

  test("runs the vision branch when benchmark harness provides a vision artifact", async () => {
    const seed = createSeed();
    let visionProviderCalls = 0;
    const report = await runResumeImportBenchmark({
      request: {
        benchmarkVersion: "033-vision-benchmark-v1",
        canaryOnly: true,
        useConfiguredAi: false,
        useVision: true,
        cases: [
          {
            id: "vision_case",
            label: "Vision case",
            resumePath: "vision.txt",
            canary: true,
            tags: ["txt", "vision"],
            expected: {
              literalFields: { fullName: "Jamie Rivers" },
              summaryContains: [],
              experienceRecords: [],
              educationRecords: [],
            },
          },
        ],
      },
      createHarness(benchmarkCase) {
        const bundle = createResumeImportFixtureBundle({
          id: benchmarkCase.id,
          parserManifestVersion: "033-vision-fixture-v1",
          pageTexts: [["Jamie Rivers"].join("\n")],
          blocks: [
            {
              id: "vision_block_1",
              pageNumber: 1,
              readingOrder: 0,
              text: "Jamie Rivers",
              kind: "heading",
              sectionHint: "identity",
              bbox: null,
              sourceParserKinds: ["plain_text"],
              sourceConfidence: 1,
              lineIds: ["vision_line_1"],
              parserLineage: ["plain_text"],
              readingOrderConfidence: 1,
              textSpan: null,
            },
          ],
          parserKinds: ["plain_text"],
          routeKind: "plain_text_native",
          qualityScore: 0.98,
        });

        return Promise.resolve({
          profile: {
            ...seed.profile,
            fullName: "Jamie Rivers",
            firstName: "Jamie",
            lastName: "Rivers",
            baseResume: {
              ...seed.profile.baseResume,
              id: "resume_vision_case",
              fileName: "vision.txt",
              textContent: bundle.fullText,
              extractionStatus: "ready",
            },
            experiences: [],
            education: [],
            certifications: [],
            links: [],
            projects: [],
            spokenLanguages: [],
          },
          searchPreferences: seed.searchPreferences,
          documentBundle: bundle,
          aiClient: null,
          visionProvider: {
            getStatus() {
              return {
                kind: "openai_compatible_vision",
                role: "vision",
                ready: true,
                label: "Configured benchmark vision provider",
                model: "FelidaeAI-Omni-3.6",
                baseUrl: "https://example.com/v1",
                modelContextWindowTokens: 139_000,
                reservedHeadroomTokens: 30_000,
                requestTimeoutMs: 75_000,
                detail: "test",
              };
            },
            extractResumeVision() {
              visionProviderCalls += 1;
              return Promise.resolve({
                analysisProviderKind: "openai_compatible_vision",
                analysisProviderLabel: "Configured benchmark vision provider",
                candidates: [],
                notes: ["Configured benchmark vision provider ran."],
                warnings: [],
                primaryErrorMessage: null,
              });
            },
          },
          parseMethod: "fixture+plain_text",
          workerManifestVersion: bundle.parserManifest?.manifestVersion ?? null,
          visionArtifact: {
            id: "vision_artifact_case",
            runId: "benchmark_run_vision_case",
            sourceResumeId: "resume_vision_case",
            sourceFileKind: "plain_text",
            createdAt: "2026-04-10T10:00:00.000Z",
            retained: "temporary",
            pages: [
              {
                id: "vision_page_case_1",
                sourceResumeId: "resume_vision_case",
                sourceFileKind: "plain_text",
                pageNumber: 1,
                renderKind: "text_rendered_preview",
                mimeType: "image/svg+xml",
                width: 1200,
                height: 1600,
                byteLength: 4,
                sha256: "abc123",
                dataUrl: "data:image/svg+xml;base64,AAAA",
                storagePath: null,
                retained: "temporary",
                generatedAt: "2026-04-10T10:00:00.000Z",
                warnings: [],
              },
            ],
            warnings: [],
          },
        });
      },
    });

    expect(report.cases[0]?.passed).toBe(true);
    expect(visionProviderCalls).toBe(1);
    expect(report.notes).toContain("Vision branch enabled for benchmark run.");
  });

  test("fails a case when auto-applied fields have no evidence", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "missing_evidence_case",
        label: "Missing evidence case",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {
            fullName: "Jamie Rivers",
          },
          summaryContains: [],
          experienceRecords: [],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        fullName: "Jamie Rivers",
      },
      searchPreferences: seed.searchPreferences,
      candidates: [
        {
          id: "candidate_full_name",
          runId: "run_1",
          target: {
            section: "identity",
            key: "fullName",
            recordId: null,
          },
          label: "Full name",
          sourceKind: "parser_literal",
          value: "Jamie Rivers",
          normalizedValue: null,
          valuePreview: "Jamie Rivers",
          evidenceText: null,
          sourceBlockIds: [],
          confidence: 0.99,
          alternatives: [],
          notes: [],
          resolution: "auto_applied",
          resolutionReason: "high_confidence_literal_with_direct_evidence",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: "2026-04-11T10:00:01.000Z",
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.taxonomy).toContain("MISSING_EVIDENCE");
  });

  test("penalizes extra experience identities even when all expected records are present", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "experience_extra_records",
        label: "Experience extra records",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {},
          summaryContains: [],
          experienceRecords: [
            {
              title: "Senior Full-Stack Software Engineer",
              companyName: "NORTHLANE",
            },
          ],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        experiences: [
          {
            id: "experience_1",
            companyName: "NORTHLANE",
            companyUrl: null,
            title: "Senior Full-Stack Software Engineer",
            employmentType: null,
            location: null,
            workMode: [],
            startDate: "07/2023",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: null,
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
          {
            id: "experience_2",
            companyName: "BRIDGEWAY L.L.C",
            companyUrl: null,
            title: "Unexpected Extra Role",
            employmentType: null,
            location: null,
            workMode: [],
            startDate: "01/2022",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: null,
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
      },
      searchPreferences: seed.searchPreferences,
      candidates: [],
    });

    expect(result.metrics.experienceRecordF1).toBeLessThan(1);
    expect(result.metrics.experienceRecordF1).toBeCloseTo(2 / 3);
  });

  test("compares equivalent resume date formats and boolean detail values", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "experience_equivalent_dates",
        label: "Equivalent experience dates",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {},
          summaryContains: [],
          experienceRecords: [
            {
              title: "Senior Product Engineer",
              companyName: "Northstar Labs",
              startDate: "2022-03",
              endDate: null,
              isCurrent: true,
            },
          ],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        experiences: [
          {
            id: "experience_1",
            companyName: "Northstar Labs",
            companyUrl: null,
            title: "Senior Product Engineer",
            employmentType: null,
            location: null,
            workMode: [],
            startDate: "March 2022",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: null,
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
      },
      searchPreferences: seed.searchPreferences,
      candidates: [],
    });

    expect(result.metrics.experienceDetailAccuracy).toBe(1);
  });

  test("does not let one fuzzy actual record satisfy multiple expected identities", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "experience_single_actual_reuse",
        label: "Experience single actual reuse",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {},
          summaryContains: [],
          experienceRecords: [
            {
              title: "Senior Full-Stack Software Engineer",
              companyName: "NORTHLANE",
            },
            {
              title: "Chief Experience Officer",
              companyName: "NORTHLANE",
            },
          ],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        experiences: [
          {
            id: "experience_1",
            companyName: "NORTHLANE",
            companyUrl: null,
            title:
              "Senior Full-Stack Software Engineer / Chief Experience Officer",
            employmentType: null,
            location: null,
            workMode: [],
            startDate: "07/2023",
            endDate: null,
            isCurrent: true,
            isDraft: false,
            summary: null,
            achievements: [],
            skills: [],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
      },
      searchPreferences: seed.searchPreferences,
      candidates: [],
    });

    expect(result.metrics.experienceRecordF1).toBeLessThan(1);
  });

  test("does not flag unresolved safe literal when matching value was auto-applied", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "duplicate_literal_case",
        label: "Duplicate literal case",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {
            email: "jamie@example.com",
          },
          summaryContains: [],
          experienceRecords: [],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        email: "jamie@example.com",
      },
      searchPreferences: seed.searchPreferences,
      candidates: [
        {
          id: "candidate_email_auto",
          runId: "run_1",
          target: {
            section: "contact",
            key: "email",
            recordId: null,
          },
          label: "Email",
          sourceKind: "parser_literal",
          value: "jamie@example.com",
          normalizedValue: null,
          valuePreview: "jamie@example.com",
          evidenceText: "jamie@example.com",
          sourceBlockIds: ["b1"],
          confidence: 0.99,
          alternatives: [],
          notes: [],
          resolution: "auto_applied",
          resolutionReason: "high_confidence_literal_with_direct_evidence",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: "2026-04-11T10:00:01.000Z",
        },
        {
          id: "candidate_email_review",
          runId: "run_1",
          target: {
            section: "contact",
            key: "email",
            recordId: null,
          },
          label: "Email",
          sourceKind: "parser_literal",
          value: "jamie@example.com",
          normalizedValue: null,
          valuePreview: "jamie@example.com",
          evidenceText: "jamie@example.com",
          sourceBlockIds: ["b1"],
          confidence: 0.7,
          alternatives: [],
          notes: [],
          resolution: "needs_review",
          resolutionReason: "duplicate_candidate_for_test",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.taxonomy).not.toContain("UNRESOLVED_SHOULD_HAVE_RESOLVED");
  });

  test("does not count rejected record candidates as extracted output", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "rejected_record_case",
        label: "Rejected record case",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {},
          summaryContains: [],
          experienceRecords: [
            { title: "Product Engineer", companyName: "Northstar Labs" },
          ],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: { ...seed.profile, experiences: [] },
      searchPreferences: seed.searchPreferences,
      candidates: [
        {
          id: "candidate_rejected_experience",
          runId: "run_1",
          target: {
            section: "experience",
            key: "record",
            recordId: "experience_1",
          },
          label: "Product Engineer",
          sourceKind: "model_experience",
          value: {
            title: "Product Engineer",
            companyName: "Northstar Labs",
          },
          normalizedValue: null,
          valuePreview: "Product Engineer at Northstar Labs",
          evidenceText: "Product Engineer at Northstar Labs",
          sourceBlockIds: ["b1"],
          confidence: 0.4,
          alternatives: [],
          notes: [],
          resolution: "rejected",
          resolutionReason: "conflicted_with_stronger_candidate",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: "2026-04-11T10:00:01.000Z",
        },
      ],
    });

    expect(result.metrics.experienceRecordF1).toBe(0);
  });

  test("penalizes extra records when an optional gold category is explicitly empty", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "explicit_empty_projects",
        label: "Explicit empty projects",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: {},
          summaryContains: [],
          experienceRecords: [],
          educationRecords: [],
          projectRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: {
        ...seed.profile,
        projects: [
          {
            id: "project_unexpected",
            name: "Unexpected Project",
            projectType: null,
            summary: "This project is not present in the gold resume.",
            role: null,
            skills: [],
            outcome: null,
            projectUrl: null,
            repositoryUrl: null,
            caseStudyUrl: null,
          },
        ],
      },
      searchPreferences: seed.searchPreferences,
      candidates: [],
    });

    expect(result.metrics.projectRecordF1).toBe(0);
  });

  test("scores auto-apply precision only against comparable gold fields", () => {
    const seed = createSeed();
    const result = buildCaseResult({
      benchmarkCase: {
        id: "comparable_auto_apply_precision",
        label: "Comparable auto apply precision",
        resumePath: "fixture.txt",
        canary: true,
        tags: ["test"],
        expected: {
          literalFields: { email: "correct@example.com" },
          summaryContains: [],
          experienceRecords: [],
          educationRecords: [],
        },
      },
      parserStrategy: "fixture+plain_text",
      profile: { ...seed.profile, email: "wrong@example.com" },
      searchPreferences: seed.searchPreferences,
      candidates: [
        {
          id: "candidate_wrong_email",
          runId: "run_1",
          target: { section: "contact", key: "email", recordId: null },
          label: "Email",
          sourceKind: "parser_literal",
          value: "wrong@example.com",
          normalizedValue: null,
          valuePreview: "wrong@example.com",
          evidenceText: "wrong@example.com",
          sourceBlockIds: ["b1"],
          confidence: 0.99,
          alternatives: [],
          notes: [],
          resolution: "auto_applied",
          resolutionReason: "high_confidence_literal_with_direct_evidence",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: "2026-04-11T10:00:01.000Z",
        },
        {
          id: "candidate_unscored_headline",
          runId: "run_1",
          target: { section: "identity", key: "headline", recordId: null },
          label: "Headline",
          sourceKind: "parser_literal",
          value: "Product Engineer",
          normalizedValue: null,
          valuePreview: "Product Engineer",
          evidenceText: "Product Engineer",
          sourceBlockIds: ["b2"],
          confidence: 0.99,
          alternatives: [],
          notes: [],
          resolution: "auto_applied",
          resolutionReason: "high_confidence_literal_with_direct_evidence",
          createdAt: "2026-04-11T10:00:00.000Z",
          resolvedAt: "2026-04-11T10:00:01.000Z",
        },
      ],
    });

    expect(result.metrics.autoApplyPrecision).toBe(0);
  });
});
