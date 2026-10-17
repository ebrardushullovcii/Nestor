import {
  ResumeParserWorkerResponseSchema,
  type ResumeDocumentParserKind,
  type ResumeParserWorkerResponse,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  mergeDocxFallbackIdentityEvidence,
  shouldFallbackToEmbeddedDocxResponse,
} from "./resume-document";

function buildDocxResponse(input: {
  parserKind: ResumeDocumentParserKind;
  text: string;
  workerKind: "embedded_node" | "python_sidecar";
}): ResumeParserWorkerResponse {
  const lines = input.text.split("\n").filter(Boolean);

  return ResumeParserWorkerResponseSchema.parse({
    requestId: "request_docx_identity_merge",
    ok: true,
    primaryParserKind: input.parserKind,
    parserKinds: [input.parserKind],
    route: {
      routeKind: "docx_native",
      triageReasons: [
        input.workerKind === "python_sidecar"
          ? "docx_sidecar_attempt"
          : "embedded_docx",
      ],
      preferredExecutors: ["local_docx", "mammoth"],
      usedExecutors: [input.parserKind],
    },
    parserManifest: {
      workerKind: input.workerKind,
      workerVersion: "fixture",
      manifestVersion: "019-docx-merge-test",
      runtimeLabel: "fixture",
      availableCapabilities: ["docx_native"],
      executorVersions: { [input.parserKind]: "fixture" },
    },
    quality: {
      score: 0.9,
      textDensity: 0.8,
      tokenCount: input.text.split(/\s+/).filter(Boolean).length,
      lineCount: lines.length,
      blockCount: lines.length,
      columnLikelihood: 0.08,
      readingOrderConfidence: 0.95,
      nativeTextCoverage: 1,
      ocrConfidence: null,
      imageCoverageRatio: 0,
      invalidUnicodeRatio: 0,
    },
    qualityWarnings: [],
    warnings: [],
    pages: [
      {
        pageNumber: 1,
        text: input.text,
        charCount: input.text.length,
        tokenCount: input.text.split(/\s+/).filter(Boolean).length,
        quality: {
          score: 0.9,
          textDensity: 0.8,
          tokenCount: input.text.split(/\s+/).filter(Boolean).length,
          lineCount: lines.length,
          blockCount: lines.length,
          columnLikelihood: 0.08,
          readingOrderConfidence: 0.95,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
        usedOcr: false,
        width: null,
        height: null,
      },
    ],
    blocks: lines.map((text, index) => ({
      id: `${input.parserKind}_block_${index + 1}`,
      pageNumber: 1,
      readingOrder: index,
      text,
      kind: index === 0 ? "heading" : "paragraph",
      sectionHint: index === 0 ? "identity" : "other",
      bbox: null,
      sourceParserKinds: [input.parserKind],
      sourceConfidence: 0.95,
      lineIds: [`${input.parserKind}_line_${index + 1}`],
      parserLineage: [input.parserKind],
      readingOrderConfidence: 0.95,
      textSpan: null,
    })),
    fullText: input.text,
    errorMessage: null,
  });
}

describe("DOCX parser fallback identity merge", () => {
  test("keeps header-only identity and contact evidence with the richer body parse", () => {
    const sidecarResponse = buildDocxResponse({
      parserKind: "local_docx",
      workerKind: "python_sidecar",
      text: [
        "Jamie Rivers",
        "Staff Frontend Engineer",
        "Berlin, Germany",
        "jamie@example.com | +49 555 0000000 | linkedin.com/in/jamie-rivers",
      ].join("\n"),
    });
    const embeddedResponse = buildDocxResponse({
      parserKind: "mammoth",
      workerKind: "embedded_node",
      text: [
        "Experience",
        "Signal Systems | Staff Frontend Engineer | 2020 - Present",
        "Built internal workflow platforms for distributed teams and led multi-quarter migrations.",
        "Directed frontend platform modernization across multiple product lines and improved release reliability.",
        "Created shared design-system primitives, accessibility standards, and test harnesses for core workflows.",
        "Partnered with recruiting and hiring teams to turn process pain points into measurable product improvements.",
        "Led cross-functional delivery reviews, roadmap planning, and post-launch regression triage for enterprise surfaces.",
        "Skills",
        "TypeScript React Playwright Architecture Leadership",
      ].join("\n"),
    });

    expect(
      shouldFallbackToEmbeddedDocxResponse({
        sidecarResponse,
        embeddedResponse,
      }),
    ).toBe(true);

    const merged = mergeDocxFallbackIdentityEvidence({
      sidecarResponse,
      embeddedResponse,
    });

    expect(merged.fullText).toContain("Jamie Rivers");
    expect(merged.fullText).toContain("jamie@example.com | +49 555 0000000");
    expect(merged.fullText).toContain("Built internal workflow platforms");
    expect(merged.parserKinds).toEqual(["mammoth", "local_docx"]);
    expect(merged.route?.triageReasons).toContain(
      "docx_identity_evidence_merged",
    );
    expect(merged.blocks[0]).toMatchObject({
      text: "Jamie Rivers",
      sectionHint: "identity",
      sourceParserKinds: ["local_docx"],
    });
  });

  test("does not prepend partial body text when contact evidence appears after a body section", () => {
    const sidecarResponse = buildDocxResponse({
      parserKind: "local_docx",
      workerKind: "python_sidecar",
      text: "Experience\nBuilt internal workflow platforms.\njamie@example.com",
    });
    const embeddedResponse = buildDocxResponse({
      parserKind: "mammoth",
      workerKind: "embedded_node",
      text: "Experience\nBuilt internal workflow platforms with reliable release controls and shared tooling.",
    });

    expect(
      mergeDocxFallbackIdentityEvidence({ sidecarResponse, embeddedResponse }),
    ).toBe(embeddedResponse);
  });
});
