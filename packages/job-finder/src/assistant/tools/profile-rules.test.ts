import { assistantTestReads } from "../store-reads.test-support";
import {
  ProfileCopilotPatchOperationSchema,
  ProfileReviewItemSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createProfileServiceHarness,
} from "../../profile-service.test-support";
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
    const { service } = createProfileServiceHarness();
    const before = await service.read();
    const apply = vi.spyOn(service, "applyAssistantProfileOperations");
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
        service,
        session: {} as AssistantTurnSession,
        ports: assistantTestReads(
          service,
        ) as unknown as AssistantHostPorts,
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
    expect((await service.read()).profile).toEqual(
      before.profile,
    );
    expect(
      (await service.read()).searchPreferences,
    ).toEqual(before.searchPreferences);
  });

  it("rejects extra keys inside nested source records and otherwise-invalid upserts", async () => {
    const { service } = createProfileServiceHarness();
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
            service,
            session: {} as AssistantTurnSession,
            ports: assistantTestReads(
              service,
            ) as unknown as AssistantHostPorts,
          },
        )
        .catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ kind: "invalid_input" });
      expect((error as Error).message).toContain("Unknown field");
      expect((error as Error).message).toContain("Allowed fields");
    }
  });

  it("preserves valid partial updates, custom preference strings and suggestion drafts", async () => {
    const { service } = createProfileServiceHarness();
    const before = await service.read();
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
      ...assistantTestReads(service),
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
      { service, session, ports },
    );
    const after = await service.read();
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
      { service, session, ports },
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
      (await service.read()).profile.headline,
    ).toBe(after.profile.headline);
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
      };
      seed.searchPreferences = { ...seed.searchPreferences, workModes: [] };
      const { service } = createProfileServiceHarness({ seed });
      const result = await readProfileTool.execute(
        { section: "basics" },
        {
          service,
          session: {
            firstProfileRead: () => Promise.resolve(false),
          } as unknown as AssistantTurnSession,
          ports: assistantTestReads(
            service,
          ) as unknown as AssistantHostPorts,
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
    const { service } = createProfileServiceHarness({ seed });
    const save = vi.spyOn(service, "saveProfileSetupState");
    const startApplications = vi.fn();
    const result = await finishProfileSetupTool.execute(
      {},
      {
        service,
        session: {
          assertCurrent: () => undefined,
        } as unknown as AssistantTurnSession,
        ports: {
          ...assistantTestReads(service),
          publishWorkspaceUpdate: () => undefined,
          startApplications,
        } as unknown as AssistantHostPorts,
      },
    );
    expect(save).toHaveBeenCalledOnce();
    expect(result.summary).toContain("Setup finished");
    expect(result.data).toMatchObject({
      setup: { status: "completed", canFinish: true },
    });
    const after = await service.read();
    expect(after.profileSetupState.status).toBe("completed");
    expect(after.profileSetupState.completedAt).not.toBeNull();
    expect(after.profileSetupState.currentStep).toBe("targeting");
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
      if (missing === "source") seed.jobSites = [];
      if (missing === "eligibility")
        seed.profile = {
          ...seed.profile,
          workEligibility: {
            ...seed.profile.workEligibility,
            authorizedWorkCountries: [],
            requiresVisaSponsorship: null,
          },
        };
      if (missing === "headline")
        seed.profile = { ...seed.profile, headline: null };
      const { service } = createProfileServiceHarness({ seed });
      const save = vi.spyOn(service, "saveProfileSetupState");
      const before = await service.read();
      const error = await finishProfileSetupTool
        .execute(
          {},
          {
            service,
            session: {
              assertCurrent: () => undefined,
            } as unknown as AssistantTurnSession,
            ports: assistantTestReads(
              service,
            ) as unknown as AssistantHostPorts,
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
        (await service.read()).profileSetupState,
      ).toEqual(before.profileSetupState);
    },
  );

  it("explains textless scanned PDF evidence separately from unsupported standalone images", async () => {
    const { service } = createProfileServiceHarness();
    const error = await readDocumentTool
      .execute(
        { documentId: "textless" },
        {
          ports: {
            ...assistantTestReads(service),
            readDocumentText: () => Promise.resolve(null),
          } as unknown as AssistantHostPorts,
          service,
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
    seed.jobSites = [];
    seed.profileSetupState = {
      ...seed.profileSetupState,
      status: "in_progress",
      completedAt: null,
    };
    const { service } = createProfileServiceHarness({ seed });
    const context = {
      service,
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
        ...assistantTestReads(service),
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
      (await service.read()).profile.phone,
    ).toBeNull();
  });

  it("exposes all current scanned review evidence beyond the workspace's eight-candidate summary", async () => {
    const { service } = createProfileServiceHarness();
    const snapshot = await service.read();
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
    vi.spyOn(
      assistantTestReads(service),
      "readPersonalState",
    ).mockResolvedValue({
      ...snapshot,
      enabledSiteCount: 1,
      latestResumeImportReviewCandidates: [],
      latestResumeImportBundle: null,
    });
    const imports = vi
      .spyOn(service, "getResumeImportState")
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
      service,
      session: {
        firstProfileRead: () => Promise.resolve(false),
        now: () => "2026-09-30T00:00:00.000Z",
        signal: new AbortController().signal,
      } as unknown as AssistantTurnSession,
      ports: assistantTestReads(
        service,
      ) as unknown as AssistantHostPorts,
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
    const { service } = createProfileServiceHarness();
    const snapshot = await service.read();
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
    vi.spyOn(service, "getResumeImportState")
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
        service,
        session: {
          assertCurrent: () => undefined,
          signal: controller.signal,
        } as unknown as AssistantTurnSession,
        ports: {
          ...assistantTestReads(service),
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
    const { service } = createProfileServiceHarness();
    const snapshot = await service.read();
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
    vi.spyOn(service, "getResumeImportState")
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, resumeImportRuns: [old, current] });
    const result = await importResumeTool.execute(
      { documentId: "empty_document" },
      {
        service,
        session: {
          assertCurrent: () => undefined,
          signal: new AbortController().signal,
        } as unknown as AssistantTurnSession,
        ports: {
          ...assistantTestReads(service),
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
    const { service } = createProfileServiceHarness();
    const publishWorkspaceUpdate = vi.fn();
    await expect(
      importResumeTool.execute(
        { documentId: "stopped_document" },
        {
          service,
          session: {
            assertCurrent: () => undefined,
            signal: new AbortController().signal,
          } as unknown as AssistantTurnSession,
          ports: {
            ...assistantTestReads(service),
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
