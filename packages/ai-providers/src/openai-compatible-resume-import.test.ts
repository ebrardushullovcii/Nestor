import { describe, expect, test } from "vitest";
import type {
  AgentProviderStatus,
  ResumeDocumentBundle,
} from "@nordri/contracts";
import { createPreferences, createProfile } from "./test-fixtures";
import { extractOpenAiCompatibleResumeImportStage } from "./openai-compatible-resume-import";

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
    existingProfile: { baseResume: { textContent: null } },
    documentBundle: { fullText: documentBundle.fullText, blocks: [] },
  });
});
