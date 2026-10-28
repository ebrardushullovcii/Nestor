import { describe, expect, test } from "vitest";
import type {
  AgentProviderStatus,
  ResumeDocumentBundle,
} from "@nestor/contracts";
import { CandidateExperienceSchema } from "@nestor/contracts";
import { createPreferences, createProfile } from "./test-fixtures";
import {
  fetchCompleteResumeImportJson,
  extractOpenAiCompatibleResumeImportStage,
} from "./openai-compatible-resume-import";

const status: AgentProviderStatus = {
  kind: "openai_compatible",
  role: "chat",
  ready: true,
  label: "AI resume agent",
  model: "test-model",
  baseUrl: "https://example.com/v1",
  modelContextWindowTokens: null,
  reservedHeadroomTokens: null,
  requestTimeoutMs: null,
  detail: null,
};

const documentBundle: ResumeDocumentBundle = {
  id: "bundle_1",
  runId: "run_1",
  sourceResumeId: "resume_1",
  sourceFileKind: "pdf",
  primaryParserKind: "pdfjs_text",
  parserKinds: ["pdfjs_text"],
  createdAt: "2026-04-10T00:00:00.000Z",
  warnings: [],
  languageHints: [],
  pages: [],
  fullText: "Elian Morava\nAddress: Prishtina, Kosovo",
  blocks: [
    {
      id: "block_1",
      pageNumber: 1,
      readingOrder: 0,
      text: "Elian Morava",
      kind: "paragraph",
      sectionHint: "identity",
      bbox: null,
      sourceParserKinds: ["pdfjs_text"],
      sourceConfidence: 0.72,
    },
  ],
};

describe("extractOpenAiCompatibleResumeImportStage", () => {
  test("extracts application links as URLs with the review label", async () => {
    const result = await extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "shared_memory",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      fetchModelJson: (_operation, request) => {
        expect(JSON.stringify(request)).toContain("preferredLinkUrls");
        expect(JSON.stringify(request)).not.toContain("or preferredLinkIds");
        return Promise.resolve({
          candidates: [
            {
              target: "application_identity.preferredLinkUrls",
              label: "Preferred link ids",
              value: ["https://example.test/portfolio"],
              confidence: 0.9,
              sourceBlockIds: ["block_1"],
            },
          ],
        });
      },
      timeoutMs: 1000,
    });
    expect(result.candidates[0]).toMatchObject({
      target: { section: "application_identity", key: "preferredLinkUrls" },
      label: "Links to include in applications",
      value: ["https://example.test/portfolio"],
    });
  });
  test("accepts a bare candidate object instead of the candidates envelope", async () => {
    // Observed from the production route: with one record to return, the
    // model answered with the candidate itself as the root object.
    const result = await extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      fetchModelJson: () =>
        Promise.resolve({
          target: { section: "identity", key: "fullName", recordId: null },
          label: "Full name",
          value: "Elian Morava",
          normalizedValue: null,
          evidenceText: "Elian Morava",
          sourceBlockIds: ["block_1"],
          confidence: 0.84,
          notes: ["top line"],
          alternatives: [],
        }),
      timeoutMs: 1_000,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      target: { section: "identity", key: "fullName" },
      value: "Elian Morava",
    });
  });

  test("accepts a bare candidate array instead of the candidates envelope", async () => {
    const result = await extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      fetchModelJson: () =>
        Promise.resolve([
          {
            target: { section: "identity", key: "fullName", recordId: null },
            label: "Full name",
            value: "Elian Morava",
            normalizedValue: null,
            evidenceText: "Elian Morava",
            sourceBlockIds: ["block_1"],
            confidence: 0.84,
            notes: [],
            alternatives: [],
          },
        ]),
      timeoutMs: 1_000,
    });

    expect(result.candidates).toHaveLength(1);
  });

  test("normalizes string notes into an array instead of failing the stage", async () => {
    const result = await extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      fetchModelJson: () =>
        Promise.resolve({
          candidates: [],
          notes: "single stage note",
        }),
      timeoutMs: 1_000,
    });

    expect(result.notes).toEqual(["single stage note"]);
    expect(result.candidates).toEqual([]);
  });

  test("normalizes string target and candidate notes into the draft schema", async () => {
    const result = await extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      fetchModelJson: () =>
        Promise.resolve({
          candidates: [
            {
              target: "identity:fullName",
              label: "Full name",
              value: "Elian Morava",
              evidenceText: "Elian Morava",
              sourceBlockIds: "block_1",
              confidence: "0.98",
              notes: "literal top line",
              alternatives: null,
              visualEvidence: [
                {
                  branch: "vision",
                  sourceFileKind: "pdf",
                  pageNumber: 1,
                  regionHint: "name heading",
                  confidence: 0.8,
                  uncertaintyNotes: [],
                },
              ],
            },
          ],
          notes: [],
        }),
      timeoutMs: 1_000,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      target: { section: "identity", key: "fullName", recordId: null },
      label: "Full name",
      value: "Elian Morava",
      sourceBlockIds: ["block_1"],
      confidence: 0.98,
      notes: ["literal top line"],
      alternatives: [],
      visualEvidence: [
        {
          branch: "vision",
          sourceFileKind: "pdf",
          pageNumber: 1,
          regionHint: "name heading",
          confidence: 0.8,
          uncertaintyNotes: [],
        },
      ],
    });

    expect(result.candidates[0]?.confidenceBreakdown?.overall).toBeGreaterThan(
      0.8,
    );
    expect(result.candidates[0]?.confidenceBreakdown?.recommendation).toBe(
      "auto_apply",
    );
  });
});

describe("round-three resume context and extraction instructions", () => {
  const source = [
    "Fatima Noor",
    "fatima@example.test",
    "Social Media Volunteer",
    "Education",
    "MSc Business",
    "BA Visual",
    "Work preferences",
    "Hamburg area warehouse work or remote dispatching",
    "Projects",
    "Pantry app — training project",
    "Research with eight users; Figma prototype; testing with five participants",
    "Certifications",
    "PMP, 2026",
    "Dribbble: https://dribbble.com/synthetic-example",
    "Ledger rewrite reduced latency from 420 ms to 8",
    "5 ms",
    "Freelance Product Designer",
    "Account Executive — exceeded sales target by 20%",
  ];
  test.each([
    "identity_summary",
    "experience",
    "background",
    "shared_memory",
  ] as const)(
    "all source sections reach the %s model, including misleading parser hints",
    async (stage) => {
      const complete = {
        ...documentBundle,
        fullText: source.join("\n"),
        blocks: source.map((text, index) => ({
          ...documentBundle.blocks[0]!,
          id: `source_${index}`,
          readingOrder: index,
          text,
          sectionHint: "other" as const,
        })),
      };
      let sent: unknown;
      let prompt = "";
      await extractOpenAiCompatibleResumeImportStage({
        stageInput: {
          stage,
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle: complete,
        },
        status,
        timeoutMs: 1000,
        fetchModelJson: (_operation, systemPrompt, payload) => {
          sent = payload;
          prompt = systemPrompt;
          return Promise.resolve({ candidates: [], notes: [] });
        },
      });
      expect(sent).toMatchObject({
        documentBundle: {
          blocks: source.map((text, index) => ({
            id: `source_${index}`,
            text,
          })),
        },
      });
      expect(sent).not.toHaveProperty("documentBundle.fullText");
      const afterBytes = new TextEncoder().encode(JSON.stringify(sent)).length;
      const sentPayload = sent as { documentBundle: object };
      const beforeBytes = new TextEncoder().encode(
        JSON.stringify({
          ...sentPayload,
          existingProfile: createProfile(),
          documentBundle: {
            ...sentPayload.documentBundle,
            fullText: complete.fullText,
          },
        }),
      ).length;
      expect(afterBytes).toBeLessThan(beforeBytes);
      console.info(
        `Import request ${stage}: ${beforeBytes} -> ${afterBytes} bytes (synthetic context fixture)`,
      );
      if (stage === "identity_summary") {
        // R3-020, R3-053, R3-086, R3-096: preserve header identity and goals.
        expect(prompt).toMatch(/contact.header name/);
        expect(prompt).toContain("both onsite and remote");
        expect(prompt).toContain("headline roles");
        expect(prompt).toContain("Deutschland to Germany");
      } else if (stage === "experience") {
        // R3-055, R3-095, R3-222: match partial roles and separate qualifications.
        expect(prompt).toContain("partial records");
        expect(prompt).toMatch(
          /education, degrees and certifications are not job achievements/,
        );
        expect(prompt).toContain("Freelance or Self-employed");
      } else if (stage === "background") {
        // R3-028 and R3-140: retain project details and labelled public links.
        expect(prompt).toContain("participant counts");
        expect(prompt).toContain("training, personal and volunteer context");
        expect(prompt).toContain("Dribbble");
      } else {
        // R3-095, R3-153, R3-223: preserve source boundaries and metric numbers.
        expect(prompt).toContain("never in employer proof points");
        expect(prompt).toContain("meaningful title");
        expect(prompt).toContain("same number and units");
        expect(prompt).toContain("numbered sales achievements");
      }
    },
  );
});

test("sends full text when the parser produced no blocks", async () => {
  let sent: unknown;
  await extractOpenAiCompatibleResumeImportStage({
    stageInput: {
      stage: "identity_summary",
      existingProfile: createProfile(),
      existingSearchPreferences: createPreferences(),
      documentBundle: { ...documentBundle, blocks: [] },
    },
    status,
    timeoutMs: 1000,
    fetchModelJson: (_operation, _prompt, payload) => {
      sent = payload;
      return Promise.resolve({ candidates: [], notes: [] });
    },
  });
  expect(sent).toMatchObject({
    documentBundle: { fullText: documentBundle.fullText, blocks: [] },
  });
  expect(sent).not.toHaveProperty("existingProfile.baseResume.textContent");
});

test("compact and released candidate forms normalize to identical evidence and review data", async () => {
  const extract = (candidate: unknown) =>
    extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle,
      },
      status,
      timeoutMs: 1000,
      fetchModelJson: () => Promise.resolve({ candidates: [candidate] }),
    });
  const common = {
    label: "Full name",
    value: "Elian Morava",
    evidenceText: "Elian Morava",
    sourceBlockIds: ["block_1"],
    confidence: 0.98,
  };
  const released = await extract({
    ...common,
    target: { section: "identity", key: "fullName", recordId: null },
    normalizedValue: null,
    notes: [],
    alternatives: [],
  });
  const compact = await extract({ ...common, target: "identity.fullName" });
  expect(compact).toEqual(released);
});

test("saved-context compaction preserves negative and numeric facts and all nonempty records", async () => {
  const base = createProfile();
  const profile = {
    ...base,
    summary: null,
    yearsExperience: 0,
    skills: [],
    experiences: [
      CandidateExperienceSchema.parse({
        id: "saved-role",
        title: "Saved role",
        companyName: "Synthetic company",
        workMode: [],
      }),
    ],
    workEligibility: {
      ...base.workEligibility,
      requiresVisaSponsorship: false,
      noticePeriodDays: 0,
    },
  };
  let sent: unknown;
  await extractOpenAiCompatibleResumeImportStage({
    stageInput: {
      stage: "experience",
      existingProfile: profile,
      existingSearchPreferences: createPreferences(),
      documentBundle,
    },
    status,
    timeoutMs: 1000,
    fetchModelJson: (_operation, _prompt, payload) => {
      sent = payload;
      return Promise.resolve({ candidates: [] });
    },
  });
  expect(sent).toMatchObject({
    existingProfile: {
      yearsExperience: 0,
      workEligibility: { requiresVisaSponsorship: false, noticePeriodDays: 0 },
      experiences: profile.experiences.map((row) => ({
        id: row.id,
        title: row.title,
        companyName: row.companyName,
      })),
    },
  });
  expect(sent).not.toHaveProperty("existingProfile.summary");
  expect(sent).not.toHaveProperty("existingProfile.skills");
});

describe("compact candidate wire rows", () => {
  const extract = (candidate: unknown, bundle = documentBundle) =>
    extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
      },
      status,
      timeoutMs: 1000,
      fetchModelJson: () => Promise.resolve({ candidates: [candidate] }),
    });

  test("equals a released object while copying the cited source verbatim", async () => {
    const object = {
      target: "identity.fullName",
      label: "Full name",
      value: "Elian Morava",
      sourceBlockIds: ["block_1"],
      evidenceText: documentBundle.blocks[0]!.text,
      confidence: 0.98,
    };
    expect(
      await extract([
        object.target,
        object.value,
        object.sourceBlockIds,
        object.confidence,
      ]),
    ).toEqual(await extract(object));
  });

  test("keeps real ambiguity, normalization and review metadata", async () => {
    const metadata = {
      label: "Full name",
      normalizedValue: "ELIAN MORAVA",
      notes: ["Source uses capitals."],
      alternatives: ["Elian Morava"],
      evidenceText: "Elian Morava",
    };
    expect(
      await extract([
        "identity.fullName",
        "Elian Morava",
        ["block_1"],
        0.97,
        metadata,
      ]),
    ).toEqual(
      await extract({
        target: "identity.fullName",
        value: "Elian Morava",
        sourceBlockIds: ["block_1"],
        confidence: 0.97,
        ...metadata,
      }),
    );
  });

  test.each([false, 0, null])(
    "preserves literal %s without treating it as missing",
    async (value) => {
      expect(
        (await extract(["identity.yearsExperience", value, ["block_1"], 0.8]))
          .candidates[0]?.value,
      ).toBe(value);
    },
  );

  test("copies distinct source blocks in order without truncation or quote rewriting", async () => {
    const bundle = {
      ...documentBundle,
      blocks: [
        documentBundle.blocks[0]!,
        {
          ...documentBundle.blocks[0]!,
          id: "block_2",
          text: "Additional literal evidence. ".repeat(100),
        },
      ],
    };
    const result = await extract(
      [
        "identity.fullName",
        "Elian Morava",
        ["block_2", "block_1", "block_2"],
        0.9,
      ],
      bundle,
    );
    expect(result.candidates[0]?.sourceBlockIds).toEqual([
      "block_2",
      "block_1",
    ]);
    expect(result.candidates[0]?.evidenceText).toBe(
      bundle.blocks[1]!.text + "\n" + bundle.blocks[0]!.text,
    );
  });

  test("requires an explicit model quote when the parser has no source blocks", async () => {
    const bundle = { ...documentBundle, blocks: [] };
    expect(
      (await extract(["identity.fullName", "Elian Morava", [], 0.9], bundle))
        .candidates,
    ).toEqual([]);
    expect(
      (
        await extract(
          [
            "identity.fullName",
            "Elian Morava",
            [],
            0.9,
            { evidenceText: "Elian Morava" },
          ],
          bundle,
        )
      ).candidates[0]?.evidenceText,
    ).toBe("Elian Morava");
  });

  test("rejects unknown/malformed rows, including targets in other languages", async () => {
    const foreignTarget =
      String.fromCodePoint(0x8eab, 0x4efd) +
      "." +
      String.fromCodePoint(0x59d3, 0x540d);
    const rows: unknown[] = [
      [],
      ["identity.fullName"],
      ["unknown.fullName", "Name", ["block_1"], 0.9],
      [foreignTarget, "Name", ["block_1"], 0.9],
      ["identity.fullName", "Name", ["missing"], 0.9],
      ["identity.fullName", "Name", [1], 0.9],
      ["identity.fullName", "Name", ["block_1"], 1.1],
      ["identity.fullName", "Name", ["block_1"], "0.9"],
      ["identity.fullName", "Name", ["block_1"], 0.9, "metadata"],
      ["identity.fullName", "Name", ["block_1"], 0.9, {}, "extra"],
    ];
    for (const row of rows) expect((await extract(row)).candidates).toEqual([]);
  });

  test("metadata cannot replace authoritative value, target, confidence or source ids", async () => {
    const result = await extract([
      "identity.fullName",
      "Elian Morava",
      ["block_1"],
      0.9,
      {
        target: "contact.email",
        value: "wrong",
        confidence: 1,
        sourceBlockIds: ["missing"],
      },
    ]);
    expect(result.candidates[0]).toMatchObject({
      target: { section: "identity", key: "fullName" },
      value: "Elian Morava",
      confidence: 0.9,
      sourceBlockIds: ["block_1"],
    });
  });

  test.each(["bare", "envelope-one", "envelope-list"])(
    "accepts a %s compact row without confusing it with a list of rows",
    async (shape) => {
      const result = await extractOpenAiCompatibleResumeImportStage({
        stageInput: {
          stage: "identity_summary",
          existingProfile: createProfile(),
          existingSearchPreferences: createPreferences(),
          documentBundle,
        },
        status,
        timeoutMs: 1000,
        fetchModelJson: () => {
          const row = ["identity.fullName", "Elian Morava", ["block_1"], 0.9];
          return Promise.resolve(
            shape === "bare"
              ? row
              : { candidates: shape === "envelope-one" ? row : [row] },
          );
        },
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.value).toBe("Elian Morava");
    },
  );
});

test("compact rows keep non-ASCII source values and reject generated unknown structure", async () => {
  const text = String.fromCodePoint(0x674e, 0x660e);
  const bundle = {
    ...documentBundle,
    blocks: [{ ...documentBundle.blocks[0]!, text }],
  };
  const run = (candidate: unknown) =>
    extractOpenAiCompatibleResumeImportStage({
      stageInput: {
        stage: "identity_summary",
        existingProfile: createProfile(),
        existingSearchPreferences: createPreferences(),
        documentBundle: bundle,
      },
      status,
      timeoutMs: 1000,
      fetchModelJson: () => Promise.resolve({ candidates: [candidate] }),
    });
  for (const confidence of [0, 1])
    expect(
      (await run(["identity.fullName", text, ["block_1"], confidence]))
        .candidates[0]?.value,
    ).toBe(text);
  for (let index = 0; index < 50; index++) {
    expect(
      (
        await run([
          String.fromCodePoint(0x400 + index) + ".fullName",
          text,
          ["block_1"],
          0.9,
        ])
      ).candidates,
    ).toEqual([]);
    expect(
      (await run(["identity.fullName", text, ["unknown_" + index], 0.9]))
        .candidates,
    ).toEqual([]);
  }
  for (const confidence of [-1, 1.1, Infinity, NaN, undefined])
    expect(
      (await run(["identity.fullName", text, ["block_1"], confidence]))
        .candidates,
    ).toEqual([]);
});

for (const operation of [
  "extractResumeImportStage",
  "adjudicateResumeImportCandidates",
] as const) {
  test(`${operation} preserves every block and candidate within budget`, async () => {
    const blocks = Array.from({ length: 300 }, (_, i) => ({
      id: `b${i}`,
      text: `Evidence ${i}`,
    }));
    const candidates = Array.from({ length: 100 }, (_, i) => ({ value: i }));
    let calls = 0;
    await fetchCompleteResumeImportJson({
      operation,
      systemPrompt: "Read all evidence",
      modelContextWindowTokens: 196000,
      payload: { documentBundle: { blocks }, candidates },
      fetch: (_prompt, payload) => {
        calls++;
        expect(payload).toEqual({ documentBundle: { blocks }, candidates });
        return Promise.resolve({ candidates: [] });
      },
    });
    expect(calls).toBe(1);
  });
  test(`${operation} reads oversized documents in chunks without losing the tail`, async () => {
    const blocks = Array.from({ length: 80 }, (_, i) => ({
      id: `b${i}`,
      text: `${i}: ` + "evidence ".repeat(100),
    }));
    const seen: string[] = [];
    const result = await fetchCompleteResumeImportJson({
      operation,
      systemPrompt: "Read all evidence",
      modelContextWindowTokens: 20000,
      payload: { documentBundle: { blocks } },
      fetch: (_prompt, payload) => {
        const chunk = payload as { documentBundle: { blocks: typeof blocks } };
        seen.push(...chunk.documentBundle.blocks.map((b) => b.id));
        return Promise.resolve({
          candidates: chunk.documentBundle.blocks.map((b) => ({
            value: b.text,
          })),
        });
      },
    });
    expect(seen).toEqual(blocks.map((b) => b.id));
    expect((result as { candidates: unknown[] }).candidates).toHaveLength(80);
  });
}
