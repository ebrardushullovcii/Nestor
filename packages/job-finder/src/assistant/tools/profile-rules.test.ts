import {
  ProfileCopilotPatchOperationSchema,
  ProfileReviewItemSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import type { AssistantHostPorts } from "../ports";
import { toConversationTool, type AssistantTurnSession } from "../tool-kit";
import {
  editProfileTool,
  finishProfileSetupTool,
  importResumeTool,
  readDocumentTool,
  readProfileTool,
  PROFILE_EDITING_RULES,
} from "./profile-tools";

describe("profile editing rules", () => {
  it("shows the model only operation shapes that validate", () => {
    const examples = [
      ...PROFILE_EDITING_RULES.matchAll(
        /\{"operation":[^;]*?\}(?=[;.] |\s\(|\.$)/gu,
      ),
    ].map((match) => match[0]);
    expect(examples.length).toBeGreaterThanOrEqual(7);
    for (const example of examples) {
      const parsed = ProfileCopilotPatchOperationSchema.safeParse(
        JSON.parse(example),
      );
      expect(parsed.success, example).toBe(true);
    }
  });

  it("exposes canonical record and preference fields to the model", () => {
    const operations = editProfileTool.parameters.properties.operations as {
      items: { anyOf: { properties: Record<string, unknown> }[] };
    };
    const schemas = operations.items.anyOf;
    function propertiesFor(operation: string, nested: string) {
      const option = schemas.find(
        (schema) =>
          (schema.properties.operation as { const: string }).const ===
          operation,
      )!;
      return option.properties[nested] as {
        properties: Record<string, unknown>;
        required: string[];
        additionalProperties: boolean;
      };
    }
    const experience = propertiesFor("upsert_experience_record", "record");
    expect(experience.additionalProperties).toBe(false);
    expect(experience.properties).toHaveProperty("companyName");
    expect(experience.properties).toHaveProperty("summary");
    expect(experience.properties).toHaveProperty("achievements");
    expect(experience.required).not.toContain("companyName");
    expect(experience.properties).not.toHaveProperty("company");
    expect(
      propertiesFor("upsert_education_record", "record").properties,
    ).toHaveProperty("schoolName");
    expect(
      propertiesFor("upsert_project_record", "record").properties,
    ).toHaveProperty("projectUrl");
    const preferences = propertiesFor(
      "replace_search_preferences_fields",
      "value",
    );
    expect(preferences.properties).toHaveProperty("workModes");
    expect(preferences.properties).toHaveProperty("seniorityLevels");
    expect(preferences.properties.employmentTypes).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(
      (preferences.properties.employmentTypes as { description: string })
        .description,
    ).toContain("Full-time");
    expect(
      propertiesFor("replace_profile_list_fields", "value").properties,
    ).not.toHaveProperty("workModes");
  });

  it("rejects the observed pasted-resume payload atomically with canonical field names", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const before = await workspaceService.getWorkspaceSnapshot();
    const apply = vi.spyOn(workspaceService, "applyAssistantProfileOperations");
    const input = editProfileTool.input.parse({
      summary: "Import pasted resume",
      operations: [
        {
          operation: "replace_identity_fields",
          value: { headline: "Senior Product Engineer" },
        },
        {
          operation: "upsert_experience_record",
          record: {
            company: "Northstar Labs",
            title: "Senior Product Engineer",
            description:
              "Built TypeScript workflow tools for operations teams.",
            bullets: [
              "Reduced manual review time by 28% through a guided validation queue.",
            ],
          },
        },
        {
          operation: "upsert_education_record",
          record: { school: "Delft University of Technology", degree: "BSc" },
        },
        {
          operation: "upsert_project_record",
          record: {
            name: "Queue Insight",
            description: "Workflow diagnostics",
            url: "https://example.test/queue-insight",
          },
        },
        {
          operation: "replace_profile_list_fields",
          value: {
            targetRoles: ["Frontend Engineer"],
            workModes: ["remote", "hybrid"],
            seniorityLevels: ["senior"],
          },
        },
      ],
    });
    const error = await editProfileTool
      .execute(input, {
        service: workspaceService,
        session: {} as AssistantTurnSession,
        ports: {} as AssistantHostPorts,
      })
      .catch((caught: unknown) => caught as Error);
    expect(error).toMatchObject({ kind: "invalid_input" });
    expect((error as Error).message).toContain(
      "operations[1].record.company: Unknown field",
    );
    expect((error as Error).message).toContain("companyName");
    expect((error as Error).message).toContain("achievements");
    expect((error as Error).message).toContain("schoolName");
    expect((error as Error).message).toContain("projectUrl");
    expect((error as Error).message).toContain("operations[4].value.workModes");
    expect(apply).not.toHaveBeenCalled();
    expect((await workspaceService.getWorkspaceSnapshot()).profile).toEqual(
      before.profile,
    );
    expect(
      (await workspaceService.getWorkspaceSnapshot()).searchPreferences,
    ).toEqual(before.searchPreferences);
  });

  it("rejects extra keys inside nested source records and otherwise-invalid upserts", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    for (const operation of [
      { operation: "upsert_education_record", record: { school: "School" } },
      {
        operation: "replace_search_preferences_fields",
        value: {
          discovery: {
            targets: [
              {
                id: "source",
                label: "Board",
                startingUrl: "https://example.test/jobs",
                queryMap: {},
              },
            ],
          },
        },
      },
    ]) {
      const error = await editProfileTool
        .execute(
          editProfileTool.input.parse({
            summary: "Update profile",
            operations: [operation],
          }),
          {
            service: workspaceService,
            session: {} as AssistantTurnSession,
            ports: {} as AssistantHostPorts,
          },
        )
        .catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ kind: "invalid_input" });
      expect((error as Error).message).toContain("Unknown field");
      expect((error as Error).message).toContain("Allowed fields");
    }
  });

  it("preserves valid partial updates, custom preference strings and suggestion drafts", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const before = await workspaceService.getWorkspaceSnapshot();
    const role = before.profile.experiences[0]!;
    const recordChange = vi.fn().mockResolvedValue({
      receipt: {
        id: "receipt_1",
        fieldLabels: ["Work history", "Employment types"],
      },
      part: { type: "notice", kind: "info", text: "Saved" },
    });
    const createProposal = vi.fn().mockResolvedValue({
      proposal: { id: "proposal_1" },
      part: { type: "notice", kind: "info", text: "Suggested" },
    });
    const session = {
      assertCurrent: () => undefined,
      recordChange,
      createProposal,
    } as unknown as AssistantTurnSession;
    const ports = {
      publishWorkspaceUpdate: () => undefined,
    } as unknown as AssistantHostPorts;
    await editProfileTool.execute(
      editProfileTool.input.parse({
        summary: "Correct employer and preferences",
        operations: [
          {
            operation: "upsert_experience_record",
            record: {
              id: role.id,
              companyName: "Northstar Labs",
              achievements: ["Reduced manual review time by 28%."],
            },
          },
          {
            operation: "replace_search_preferences_fields",
            value: {
              employmentTypes: ["Part-time", "Seasonal mornings"],
              seniorityLevels: ["senior", "department head"],
              workModes: ["remote", "hybrid"],
            },
          },
        ],
      }),
      { service: workspaceService, session, ports },
    );
    const after = await workspaceService.getWorkspaceSnapshot();
    const savedRole = after.profile.experiences.find(
      (entry) => entry.id === role.id,
    )!;
    expect(savedRole.companyName).toBe("Northstar Labs");
    expect(savedRole.achievements).toEqual([
      "Reduced manual review time by 28%.",
    ]);
    expect(savedRole.title).toBe(role.title);
    expect(savedRole.startDate).toBe(role.startDate);
    expect(after.searchPreferences.employmentTypes).toEqual([
      "Part-time",
      "Seasonal mornings",
    ]);
    expect(after.searchPreferences.seniorityLevels).toEqual([
      "senior",
      "department head",
    ]);
    expect(after.searchPreferences.workModes).toEqual(["remote", "hybrid"]);
    await editProfileTool.execute(
      editProfileTool.input.parse({
        summary: "Suggest a headline",
        mode: "suggest",
        operations: [
          {
            operation: "replace_identity_fields",
            value: { headline: "Suggested headline" },
          },
        ],
      }),
      { service: workspaceService, session, ports },
    );
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "profile_operations",
        items: [
          expect.objectContaining({
            payload: {
              operation: "replace_identity_fields",
              value: { headline: "Suggested headline" },
            },
          }),
        ],
      }),
    );
    expect(
      (await workspaceService.getWorkspaceSnapshot()).profile.headline,
    ).toBe(after.profile.headline);
  });

  it("tells the model when a saved profile change cleared an existing resume approval", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const artifact = exported.resumeExportArtifacts.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await workspaceService.approveResume("job_ready", artifact.id);
    const session = {
      assertCurrent: () => undefined,
      recordChange: () =>
        Promise.resolve({
          receipt: { id: "receipt_1", fieldLabels: ["Headline"] },
          part: { type: "notice", kind: "info", text: "Saved" },
        }),
    } as unknown as AssistantTurnSession;
    const result = await editProfileTool.execute(
      editProfileTool.input.parse({
        summary: "Update headline",
        operations: [
          {
            operation: "replace_identity_fields",
            value: { headline: "Senior Frontend Platform Engineer" },
          },
        ],
      }),
      {
        service: workspaceService,
        session,
        ports: {
          publishWorkspaceUpdate: () => undefined,
        } as unknown as AssistantHostPorts,
      },
    );
    expect(result.summary).toContain("cleared approval on 1 resume");
    expect(result.summary).toContain("need refreshing and fresh review");
    expect(result.data).toMatchObject({
      invalidatedApprovedResumeJobIds: ["job_ready"],
    });
    const savedResume = await workspaceService.getResumeWorkspace("job_ready");
    expect(savedResume.draft.status).toBe("stale");
    expect(savedResume.draft.approvedExportId).toBeNull();
  });
});

describe("sidebar resume import outcomes", () => {
  it.each([
    { countries: [], sponsorship: false, missing: ["authorizedWorkCountries"] },
    {
      countries: ["Netherlands"],
      sponsorship: null,
      missing: ["requiresVisaSponsorship"],
    },
    { countries: ["Netherlands"], sponsorship: false, missing: [] },
  ])(
    "names only the actually missing setup eligibility answers: $missing",
    async ({ countries, sponsorship, missing }) => {
      const seed = createSeed();
      seed.profile = {
        ...seed.profile,
        workEligibility: {
          ...seed.profile.workEligibility,
          authorizedWorkCountries: countries,
          requiresVisaSponsorship: sponsorship,
          willingToRelocate: null,
          noticePeriodDays: null,
          availableStartDate: null,
          remoteEligible: null,
        },
        answerBank: {
          ...seed.profile.answerBank,
          workAuthorization: null,
          visaSponsorship: null,
        },
      };
      seed.searchPreferences = { ...seed.searchPreferences, workModes: [] };
      const { workspaceService } = createWorkspaceServiceHarness({ seed });
      const result = await readProfileTool.execute(
        { section: "basics" },
        {
          service: workspaceService,
          session: {
            firstProfileRead: () => Promise.resolve(false),
          } as unknown as AssistantTurnSession,
          ports: {} as AssistantHostPorts,
        },
      );
      const setup = (
        result.data as {
          setup: {
            missingWorkEligibilityAnswers: { field: string }[];
            canFinish: boolean;
            note: string;
          };
        }
      ).setup;
      expect(
        setup.missingWorkEligibilityAnswers.map((answer) => answer.field),
      ).toEqual(missing);
      expect(setup.canFinish).toBe(missing.length === 0);
      expect(setup.note).toContain("work-mode preferences are optional");
    },
  );

  it("finishes ready setup through the existing service without starting search or applying", async () => {
    const seed = createSeed();
    seed.profileSetupState = {
      ...seed.profileSetupState,
      status: "in_progress",
      completedAt: null,
    };
    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const save = vi.spyOn(workspaceService, "saveProfileSetupState");
    const startSearch = vi.fn();
    const startApplications = vi.fn();
    const result = await finishProfileSetupTool.execute(
      {},
      {
        service: workspaceService,
        session: {
          assertCurrent: () => undefined,
        } as unknown as AssistantTurnSession,
        ports: {
          publishWorkspaceUpdate: () => undefined,
          startSearch,
          startApplications,
        } as unknown as AssistantHostPorts,
      },
    );
    expect(save).toHaveBeenCalledOnce();
    expect(result.summary).toContain("Setup finished");
    expect(result.data).toMatchObject({
      setup: { status: "completed", canFinish: true },
    });
    const after = await workspaceService.getWorkspaceSnapshot();
    expect(after.profileSetupState.status).toBe("completed");
    expect(after.profileSetupState.completedAt).not.toBeNull();
    expect(after.profileSetupState.currentStep).toBe("targeting");
    expect(startSearch).not.toHaveBeenCalled();
    expect(startApplications).not.toHaveBeenCalled();
  });

  it.each(["source", "eligibility", "headline"] as const)(
    "does not write completion when %s is still required",
    async (missing) => {
      const seed = createSeed();
      seed.profileSetupState = {
        ...seed.profileSetupState,
        status: "in_progress",
        completedAt: null,
      };
      if (missing === "source")
        seed.searchPreferences = {
          ...seed.searchPreferences,
          discovery: { ...seed.searchPreferences.discovery, targets: [] },
        };
      if (missing === "eligibility")
        seed.profile = {
          ...seed.profile,
          workEligibility: {
            ...seed.profile.workEligibility,
            authorizedWorkCountries: [],
            requiresVisaSponsorship: null,
          },
          answerBank: {
            ...seed.profile.answerBank,
            workAuthorization: null,
            visaSponsorship: null,
          },
        };
      if (missing === "headline")
        seed.profile = { ...seed.profile, headline: null };
      const { workspaceService } = createWorkspaceServiceHarness({ seed });
      const save = vi.spyOn(workspaceService, "saveProfileSetupState");
      const before = await workspaceService.getWorkspaceSnapshot();
      const error = await finishProfileSetupTool
        .execute(
          {},
          {
            service: workspaceService,
            session: {
              assertCurrent: () => undefined,
            } as unknown as AssistantTurnSession,
            ports: {} as AssistantHostPorts,
          },
        )
        .catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ kind: "missing_information" });
      expect((error as Error).message).toContain(
        missing === "source"
          ? "enabled job source"
          : missing === "eligibility"
            ? "legally authorized to work"
            : "Headline",
      );
      expect(save).not.toHaveBeenCalled();
      expect(
        (await workspaceService.getWorkspaceSnapshot()).profileSetupState,
      ).toEqual(before.profileSetupState);
    },
  );

  it("explains textless scanned PDF evidence separately from unsupported standalone images", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const error = await readDocumentTool
      .execute(
        { documentId: "textless" },
        {
          ports: {
            readDocumentText: () => Promise.resolve(null),
          } as unknown as AssistantHostPorts,
          service: workspaceService,
          session: {} as AssistantTurnSession,
        },
      )
      .catch((caught: unknown) => caught as Error);
    expect((error as Error).message).toContain("read_profile section review");
    expect((error as Error).message).toContain("PDF, DOCX, TXT and Markdown");
    expect((error as Error).message).toContain(
      "PNG/JPG images are unsupported",
    );
    expect((error as Error).message).toContain("pasted text");
  });
  it("returns the actual setup blockers after a first-job edit and separates optional phone", async () => {
    const seed = createSeed();
    seed.profile = { ...seed.profile, headline: null, phone: null };
    seed.searchPreferences = {
      ...seed.searchPreferences,
      discovery: { ...seed.searchPreferences.discovery, targets: [] },
    };
    seed.profileSetupState = {
      ...seed.profileSetupState,
      status: "in_progress",
      completedAt: null,
    };
    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const context = {
      service: workspaceService,
      session: {
        assertCurrent: () => undefined,
        firstProfileRead: () => Promise.resolve(true),
        recordChange: () =>
          Promise.resolve({
            receipt: { id: "setup_receipt", fieldLabels: ["Skills"] },
            part: { type: "notice", kind: "info", text: "Saved" },
          }),
      } as unknown as AssistantTurnSession,
      ports: {
        publishWorkspaceUpdate: () => undefined,
      } as unknown as AssistantHostPorts,
    };
    const read = await readProfileTool.execute({ section: "basics" }, context);
    expect(read.data).toMatchObject({
      setup: {
        canFinish: false,
        blockers: [{ id: "discovery_source" }],
        requiredReviewItems: [expect.objectContaining({ label: "Headline" })],
      },
    });
    const changed = await editProfileTool.execute(
      editProfileTool.input.parse({
        summary: "Set the stated target focus",
        operations: [
          {
            operation: "replace_identity_fields",
            value: { headline: "Retail and Customer Service" },
          },
        ],
      }),
      context,
    );
    expect(changed.data).toMatchObject({
      setup: {
        canFinish: false,
        blockers: [{ id: "discovery_source" }],
        requiredReviewItems: [],
      },
    });
    expect(
      (await workspaceService.getWorkspaceSnapshot()).profile.phone,
    ).toBeNull();
  });

  it("exposes all current scanned review evidence beyond the workspace's eight-candidate summary", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const run = ResumeImportRunSchema.parse({
      id: "scan_run",
      sourceResumeId: snapshot.profile.baseResume.id,
      sourceResumeFileName: "scan.pdf",
      status: "review_ready",
      startedAt: "2026-09-30T00:00:00.000Z",
    });
    const candidates = Array.from({ length: 14 }, (_, index) =>
      ResumeImportFieldCandidateSchema.parse({
        id: `resume_import_resume_import_run_931af685-69b5-4435-9203-205871b902e6_vision_omni_${10000 + index}_identity_fullname_full_name`,
        runId: run.id,
        target: { section: "identity", key: "fullName" },
        label: `Name ${index}`,
        sourceKind: "vision_omni",
        value: "Morgan Lee",
        evidenceText: "Morgan Lee, shown in the scan's name header. ".repeat(
          12,
        ),
        confidence: 0.98,
        visualEvidence: [
          {
            branch: "vision",
            sourceFileKind: "pdf",
            pageNumber: 1,
            regionHint: "Top of left column - name header",
            confidence: 0.98,
            uncertaintyNotes: [],
          },
        ],
        createdAt: run.startedAt,
      }),
    );
    snapshot.profileSetupState.reviewItems = candidates.map((candidate) =>
      ProfileReviewItemSchema.parse({
        id: `review_${candidate.id}`,
        step: "essentials",
        target: { domain: "identity", key: "fullName" },
        label: candidate.label,
        reason: "Confirm visual extraction",
        severity: "recommended",
        status: "pending",
        proposedValue: "Morgan Lee",
        sourceCandidateId: candidate.id,
        sourceRunId: run.id,
        createdAt: run.startedAt,
      }),
    );
    const stale = ResumeImportFieldCandidateSchema.parse({
      ...candidates[0],
      id: "old_scan",
      runId: "old_run",
    });
    vi.spyOn(workspaceService, "getWorkspaceSnapshot").mockResolvedValue(
      snapshot,
    );
    const imports = vi
      .spyOn(workspaceService, "getResumeImportState")
      .mockResolvedValue({
        activeVisionRunIds: [],
        resumeImportRuns: [
          run,
          ResumeImportRunSchema.parse({
            ...run,
            id: "old_run",
            startedAt: "2026-09-29T00:00:00.000Z",
          }),
        ],
        resumeImportDocumentBundles: [],
        resumeImportFieldCandidates: [...candidates, stale],
      });
    const context = {
      service: workspaceService,
      session: {
        firstProfileRead: () => Promise.resolve(false),
        now: () => "2026-09-30T00:00:00.000Z",
        signal: new AbortController().signal,
      } as unknown as AssistantTurnSession,
      ports: {} as AssistantHostPorts,
    };
    await readProfileTool.execute({ section: "basics" }, context);
    expect(imports).not.toHaveBeenCalled();
    context.session.firstProfileRead = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    type EvidencePage = {
      pendingReviewCount: number;
      pendingImportCandidateCount: number;
      reviewItems: {
        id: string;
        sourceCandidateId: string | null;
        sourceRunId: string | null;
      }[];
      importCandidates: {
        candidateId: string;
        runId: string;
        resolution: string;
        value: unknown;
        evidenceText: string;
        visualEvidence: unknown[];
      }[];
      importOutcome: {
        totalDetailCount: number;
        savedDetailCount: number;
        pendingDetailCount: number;
      };
      nextRead: {
        section: "review";
        reviewOffset: number;
        importOffset: number;
        limit: number;
      } | null;
    };
    async function readRenderedPages() {
      const tool = toConversationTool(readProfileTool, context, {
        parts: [],
        endTurn: null,
        activity: [],
        touched: [],
      });
      const pages: EvidencePage[] = [];
      let args: {
        section: "review";
        reviewOffset?: number;
        importOffset?: number;
        limit?: number;
      } | null = { section: "review" };
      while (args && pages.length < 40) {
        const output = await tool.execute(JSON.stringify(args), {
          step: pages.length,
          signal: context.session.signal,
        });
        if (output.kind !== "ok")
          throw new Error("Expected a rendered tool result");
        expect(output.content).not.toContain("(cut; ask for a smaller page)");
        const serialized = output.content.slice(
          output.content.indexOf("\n") + 1,
        );
        expect(serialized.length).toBeLessThan(11_000);
        const page = JSON.parse(serialized) as EvidencePage;
        expect(page.nextRead).not.toEqual(args);
        pages.push(page);
        args = page.nextRead;
      }
      expect(args).toBeNull();
      return pages;
    }
    const pages = await readRenderedPages();
    expect(pages.length).toBeGreaterThan(1);
    const evidence = pages.flatMap((page) => page.importCandidates);
    const reviews = pages.flatMap((page) => page.reviewItems);
    expect(reviews).toHaveLength(14);
    expect(evidence).toHaveLength(14);
    for (const page of pages)
      expect(page).toMatchObject({
        pendingReviewCount: 14,
        pendingImportCandidateCount: 14,
      });
    expect(
      evidence.find(
        (candidate) => candidate.candidateId === reviews[13]!.sourceCandidateId,
      ),
    ).toMatchObject({
      candidateId: candidates[13]!.id,
      confidence: 0.98,
      evidenceText: candidates[13]!.evidenceText,
      visualEvidence: [
        expect.objectContaining({
          pageNumber: 1,
          regionHint: "Top of left column - name header",
        }),
      ],
    });
    expect(
      evidence.some((candidate) => candidate.candidateId === stale.id),
    ).toBe(false);
    snapshot.profileSetupState.reviewItems = [];
    imports.mockResolvedValue({
      activeVisionRunIds: [],
      resumeImportRuns: [run],
      resumeImportDocumentBundles: [],
      resumeImportFieldCandidates: candidates.map((candidate) => ({
        ...candidate,
        resolution: "auto_applied" as const,
      })),
    });
    const savedPages = await readRenderedPages();
    for (const saved of savedPages)
      expect(saved).toMatchObject({
        pendingReviewCount: 0,
        pendingImportCandidateCount: 0,
        reviewItems: [],
        importOutcome: {
          runId: run.id,
          totalDetailCount: 14,
          savedDetailCount: 14,
          pendingDetailCount: 0,
          rejectedDetailCount: 0,
        },
      });
    expect(savedPages.flatMap((page) => page.importCandidates)).toHaveLength(
      14,
    );
    expect(savedPages.flatMap((page) => page.importCandidates)).toContainEqual(
      expect.objectContaining({
        candidateId: candidates[13]!.id,
        resolution: "auto_applied",
        value: "Morgan Lee",
        evidenceText: candidates[13]!.evidenceText,
        visualEvidence: [expect.objectContaining({ pageNumber: 1 })],
      }),
    );
    context.session.firstProfileRead = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    imports.mockResolvedValue({
      activeVisionRunIds: [],
      resumeImportRuns: [run],
      resumeImportDocumentBundles: [],
      resumeImportFieldCandidates: [
        {
          ...candidates[0]!,
          value: "Synthetic oversized detail. ".repeat(6000),
          normalizedValue: null,
          resolution: "auto_applied",
        },
      ],
    });
    const oversizedPages = await readRenderedPages();
    expect(oversizedPages).toHaveLength(1);
    expect(oversizedPages[0]!.importCandidates).toHaveLength(1);
    expect(oversizedPages[0]!.importCandidates[0]).toMatchObject({
      candidateId: candidates[0]!.id,
      valueTruncated: true,
      visualEvidence: [expect.objectContaining({ pageNumber: 1 })],
    });
  });

  it("reports only matching completed-import candidates, including vision-only details", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const run = ResumeImportRunSchema.parse({
      id: "new_import",
      sourceResumeId: snapshot.profile.baseResume.id,
      sourceResumeFileName: "scan.png",
      status: "review_ready",
      startedAt: "2026-09-30T00:00:00.000Z",
    });
    const candidate = ResumeImportFieldCandidateSchema.parse({
      id: "candidate",
      runId: run.id,
      target: { section: "identity", key: "fullName" },
      label: "Name",
      sourceKind: "vision_omni",
      value: "Taylor Quinn",
      confidence: 0.99,
      resolution: "auto_applied",
      createdAt: run.startedAt,
    });
    const empty = {
      activeVisionRunIds: [],
      resumeImportRuns: [],
      resumeImportDocumentBundles: [],
      resumeImportFieldCandidates: [],
    };
    vi.spyOn(workspaceService, "getResumeImportState")
      .mockResolvedValueOnce(empty)
      .mockResolvedValueOnce({
        ...empty,
        resumeImportRuns: [run],
        resumeImportFieldCandidates: [candidate],
      });
    const controller = new AbortController();
    const importResumeDocument = vi.fn().mockResolvedValue(undefined);
    const result = await importResumeTool.execute(
      { documentId: "scan_document" },
      {
        service: workspaceService,
        session: {
          assertCurrent: () => undefined,
          signal: controller.signal,
        } as unknown as AssistantTurnSession,
        ports: {
          importResumeDocument,
          publishWorkspaceUpdate: () => undefined,
        } as unknown as AssistantHostPorts,
      },
    );
    expect(importResumeDocument).toHaveBeenCalledWith("scan_document", {
      signal: controller.signal,
    });
    expect(result.summary).toContain("1 detail saved");
    expect(result.data).toMatchObject({
      runId: run.id,
      outcome: "completed",
      savedDetailCount: 1,
      reviewSuggestionCount: 0,
      savedCollections: { spokenLanguages: snapshot.profile.spokenLanguages },
    });
    expect(JSON.stringify(result.data)).toContain("add any missing languages");
  });

  it("does not credit existing facts or older import candidates to an empty new file", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const old = ResumeImportRunSchema.parse({
      id: "old_import",
      sourceResumeId: snapshot.profile.baseResume.id,
      sourceResumeFileName: "old.txt",
      status: "applied",
      startedAt: "2026-09-29T00:00:00.000Z",
    });
    const current = ResumeImportRunSchema.parse({
      ...old,
      id: "new_import",
      sourceResumeFileName: "empty.png",
      startedAt: "2026-09-30T00:00:00.000Z",
    });
    const oldCandidate = ResumeImportFieldCandidateSchema.parse({
      id: "old_candidate",
      runId: old.id,
      target: { section: "identity", key: "fullName" },
      label: "Name",
      sourceKind: "parser_literal",
      value: "Taylor Quinn",
      confidence: 0.99,
      resolution: "auto_applied",
      createdAt: old.startedAt,
    });
    const state = {
      activeVisionRunIds: [],
      resumeImportRuns: [old],
      resumeImportDocumentBundles: [],
      resumeImportFieldCandidates: [oldCandidate],
    };
    vi.spyOn(workspaceService, "getResumeImportState")
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, resumeImportRuns: [old, current] });
    const result = await importResumeTool.execute(
      { documentId: "empty_document" },
      {
        service: workspaceService,
        session: {
          assertCurrent: () => undefined,
          signal: new AbortController().signal,
        } as unknown as AssistantTurnSession,
        ports: {
          importResumeDocument: () => Promise.resolve(),
          publishWorkspaceUpdate: () => undefined,
        } as unknown as AssistantHostPorts,
      },
    );
    expect(result.summary).toContain("no usable new profile details");
    expect(result.summary).toContain("Existing profile facts were kept");
    expect(result.data).toMatchObject({
      runId: current.id,
      outcome: "no_usable_details",
    });
  });

  it("does not publish a successful import after the port fails or is stopped", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const publishWorkspaceUpdate = vi.fn();
    await expect(
      importResumeTool.execute(
        { documentId: "stopped_document" },
        {
          service: workspaceService,
          session: {
            assertCurrent: () => undefined,
            signal: new AbortController().signal,
          } as unknown as AssistantTurnSession,
          ports: {
            importResumeDocument: () =>
              Promise.reject(new Error("Import stopped")),
            publishWorkspaceUpdate,
          } as unknown as AssistantHostPorts,
        },
      ),
    ).rejects.toThrow("Import stopped");
    expect(publishWorkspaceUpdate).not.toHaveBeenCalled();
  });
});
