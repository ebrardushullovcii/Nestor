import type {
  ResumeDocumentBlock,
  ResumeDocumentBundle,
  ResumeDocumentPage,
  ResumeImportBenchmarkCase,
} from "@nestor/contracts";

function createPage(input: Partial<ResumeDocumentPage> & Pick<ResumeDocumentPage, "pageNumber">): ResumeDocumentPage {
  return {
    pageNumber: input.pageNumber,
    text: input.text ?? null,
    charCount: input.charCount ?? (input.text?.length ?? 0),
    parserKinds: input.parserKinds ?? ["local_pdf_layout"],
    usedOcr: input.usedOcr ?? false,
    ...(input.width !== undefined ? { width: input.width } : {}),
    ...(input.height !== undefined ? { height: input.height } : {}),
    ...(input.rotationDegrees !== undefined ? { rotationDegrees: input.rotationDegrees } : {}),
    ...(input.routeKind !== undefined ? { routeKind: input.routeKind } : {}),
    ...(input.quality !== undefined ? { quality: input.quality } : {}),
    ...(input.qualityWarnings !== undefined ? { qualityWarnings: input.qualityWarnings } : {}),
  };
}

function createBlock(input: Partial<ResumeDocumentBlock> & Pick<ResumeDocumentBlock, "id" | "pageNumber" | "readingOrder" | "text">): ResumeDocumentBlock {
  return {
    id: input.id,
    pageNumber: input.pageNumber,
    readingOrder: input.readingOrder,
    text: input.text,
    kind: input.kind ?? "paragraph",
    sectionHint: input.sectionHint ?? "other",
    bbox: input.bbox ?? null,
    sourceParserKinds: input.sourceParserKinds ?? ["local_pdf_layout"],
    sourceConfidence: input.sourceConfidence ?? 0.9,
    ...(input.lineIds !== undefined ? { lineIds: input.lineIds } : {}),
    ...(input.parserLineage !== undefined ? { parserLineage: input.parserLineage } : {}),
    ...(input.readingOrderConfidence !== undefined
      ? { readingOrderConfidence: input.readingOrderConfidence }
      : {}),
    ...(input.textSpan !== undefined ? { textSpan: input.textSpan } : {}),
  };
}

export function createResumeImportFixtureBundle(options: {
  id: string;
  sourceResumeId?: string;
  parserKinds?: ResumeDocumentBundle["parserKinds"];
  parserManifestVersion?: string;
  routeKind?: NonNullable<ResumeDocumentBundle["route"]>["routeKind"];
  qualityScore?: number;
  pageTexts: string[];
  blocks: ResumeDocumentBlock[];
}): ResumeDocumentBundle {
  const parserKinds = options.parserKinds ?? ["local_pdf_layout"];
  const fullText = options.pageTexts.join("\n\n");

  return {
    id: options.id,
    runId: `fixture_run_${options.id}`,
    sourceResumeId: options.sourceResumeId ?? `resume_${options.id}`,
    sourceFileKind: "pdf",
    primaryParserKind: parserKinds[0] ?? "local_pdf_layout",
    parserKinds,
    createdAt: "2026-04-11T00:00:00.000Z",
    languageHints: [],
    warnings: [],
    parserManifest: {
      workerKind: "python_sidecar",
      workerVersion: "0.1.0",
      manifestVersion: options.parserManifestVersion ?? "parser-manifest-v1",
      runtimeLabel: "fixture",
      availableCapabilities: ["pdf_layout"],
      executorVersions: Object.fromEntries(parserKinds.map((kind) => [kind, "fixture"])),
    },
    route: {
      routeKind: options.routeKind ?? "native_first",
      triageReasons: ["fixture"],
      preferredExecutors: parserKinds,
      usedExecutors: parserKinds,
    },
    quality: {
      score: options.qualityScore ?? 0.93,
      textDensity: 0.8,
      tokenCount: fullText.split(/\s+/).filter(Boolean).length,
      lineCount: fullText.split(/\r?\n/).filter(Boolean).length,
      blockCount: options.blocks.length,
      columnLikelihood: 0.18,
      readingOrderConfidence: 0.95,
      nativeTextCoverage: 1,
      ocrConfidence: null,
      imageCoverageRatio: 0,
      invalidUnicodeRatio: 0,
    },
    qualityWarnings: [],
    pages: options.pageTexts.map((text, index) =>
      createPage({
        pageNumber: index + 1,
        text,
        parserKinds,
        usedOcr: false,
        width: 612,
        height: 792,
        rotationDegrees: 0,
        routeKind: options.routeKind ?? "native_first",
        quality: {
          score: options.qualityScore ?? 0.93,
          textDensity: 0.8,
          tokenCount: text.split(/\s+/).filter(Boolean).length,
          lineCount: text.split(/\r?\n/).filter(Boolean).length,
          blockCount: options.blocks.filter((block) => block.pageNumber === index + 1).length,
          columnLikelihood: 0.18,
          readingOrderConfidence: 0.95,
          nativeTextCoverage: 1,
          ocrConfidence: null,
          imageCoverageRatio: 0,
          invalidUnicodeRatio: 0,
        },
        qualityWarnings: [],
      }),
    ),
    blocks: options.blocks,
    fullText,
  };
}

export const ELIAN_IMPORTED_TEXT = [
  "Elian Morava",
  "Address: Prishtina, Kosovo (Home)",
  "ABOUT ME",
  "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
  "WORK EXPERIENCE",
  "NORTHLANE – PRISHTINA, KOSOVO",
  "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
  "Project Lead (React, Next.js) – QA Management System",
  "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
  ".NET CONSULTANT – 01/2022 – Current",
  ".NET DEVELOPER – 08/2019 – 01/2022",
  "LUMIQUE – PRISHTINA, KOSOVO",
  "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
].join("\n");

export const ELIAN_IMPORT_FIXTURE_BUNDLE = createResumeImportFixtureBundle({
  id: "elian_fixture_bundle",
  qualityScore: 0.95,
  pageTexts: [
    [
      "Elian Morava",
      "Address: Prishtina, Kosovo (Home)",
      "ABOUT ME",
      "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.",
      "WORK EXPERIENCE",
      "NORTHLANE – PRISHTINA, KOSOVO",
      "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current",
      "Project Lead (React, Next.js) – QA Management System",
    ].join("\n"),
    [
      "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO",
      ".NET CONSULTANT – 01/2022 – Current",
      ".NET DEVELOPER – 08/2019 – 01/2022",
      "LUMIQUE – PRISHTINA, KOSOVO",
      "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023",
    ].join("\n"),
  ],
  blocks: [
    createBlock({ id: "b1", pageNumber: 1, readingOrder: 0, text: "Elian Morava", kind: "heading", sectionHint: "identity", bbox: { left: 14, top: 811, width: 144, height: 16 }, lineIds: ["l1"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.99 }),
    createBlock({ id: "b2", pageNumber: 1, readingOrder: 1, text: "Address: Prishtina, Kosovo (Home)", kind: "contact", sectionHint: "contact", bbox: { left: 14, top: 733, width: 162, height: 10 }, lineIds: ["l2"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.98 }),
    createBlock({ id: "b3", pageNumber: 1, readingOrder: 2, text: "ABOUT ME", kind: "heading", sectionHint: "summary", bbox: { left: 28, top: 690, width: 58, height: 11 }, lineIds: ["l3"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.98 }),
    createBlock({ id: "b4", pageNumber: 1, readingOrder: 3, text: "A passionate software developer with 6+ years of full-stack experience building impactful solutions using React, Next.js, Node.js, .NET Core, SQL Server and AWS/Azure.", kind: "paragraph", sectionHint: "summary", bbox: { left: 28, top: 665, width: 552, height: 40 }, lineIds: ["l4", "l5"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.97 }),
    createBlock({ id: "b5", pageNumber: 1, readingOrder: 4, text: "WORK EXPERIENCE", kind: "heading", sectionHint: "experience", bbox: { left: 28, top: 323, width: 104, height: 11 }, lineIds: ["l6"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.98 }),
    createBlock({ id: "b6", pageNumber: 1, readingOrder: 5, text: "NORTHLANE – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "experience", bbox: { left: 28, top: 296, width: 186, height: 10 }, lineIds: ["l7"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.98 }),
    createBlock({ id: "b7", pageNumber: 1, readingOrder: 6, text: "SENIOR FULL-STACK SOFTWARE ENGINEER – 07/2023 – Current", kind: "experience_header", sectionHint: "experience", bbox: { left: 45, top: 258, width: 313, height: 11 }, lineIds: ["l8"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.97 }),
    createBlock({ id: "b8", pageNumber: 1, readingOrder: 7, text: "Project Lead (React, Next.js) – QA Management System", kind: "experience_header", sectionHint: "experience", bbox: { left: 45, top: 87, width: 253, height: 10 }, lineIds: ["l9"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.9 }),
    createBlock({ id: "b9", pageNumber: 2, readingOrder: 0, text: "BRIDGEWAY L.L.C – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "experience", bbox: { left: 28, top: 740, width: 186, height: 10 }, lineIds: ["l10"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.98 }),
    createBlock({ id: "b10", pageNumber: 2, readingOrder: 1, text: ".NET CONSULTANT – 01/2022 – Current", kind: "experience_header", sectionHint: "experience", bbox: { left: 45, top: 705, width: 250, height: 10 }, lineIds: ["l11"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.97 }),
    createBlock({ id: "b11", pageNumber: 2, readingOrder: 2, text: ".NET DEVELOPER – 08/2019 – 01/2022", kind: "experience_header", sectionHint: "experience", bbox: { left: 45, top: 664, width: 250, height: 10 }, lineIds: ["l12"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.97 }),
    createBlock({ id: "b12", pageNumber: 2, readingOrder: 3, text: "LUMIQUE – PRISHTINA, KOSOVO", kind: "heading", sectionHint: "experience", bbox: { left: 28, top: 624, width: 186, height: 10 }, lineIds: ["l13"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.97 }),
    createBlock({ id: "b13", pageNumber: 2, readingOrder: 4, text: "CHIEF EXPERIENCE OFFICER – 11/2021 – 07/2023", kind: "experience_header", sectionHint: "experience", bbox: { left: 45, top: 588, width: 250, height: 10 }, lineIds: ["l14"], parserLineage: ["local_pdf_layout"], readingOrderConfidence: 0.96 }),
  ],
});

export const OWEN_IMPORT_FIXTURE_BUNDLE = createResumeImportFixtureBundle({
  id: "owen_fixture_bundle",
  qualityScore: 0.93,
  pageTexts: [
    [
      "Owen Mercer",
      "Senior Software Engineer",
      "Tampa, FL",
      "+1 555-010-5538",
      "owen.mercer@example.test",
      "PROFESSIONAL SUMMARY",
      "Experienced Staff Engineer with a focus on leading complex, high-impact initiatives across full-stack systems.",
      "EXPERIENCE",
      "EdSights, Remote, NY — Staff/Senior Software Engineer",
      "Sep 2021 – Feb 2026",
    ].join("\n"),
  ],
  blocks: [
    createBlock({ id: "a1", pageNumber: 1, readingOrder: 0, text: "Owen Mercer", kind: "heading", sectionHint: "identity", bbox: { left: 36, top: 742, width: 143, height: 22 } }),
    createBlock({ id: "a2", pageNumber: 1, readingOrder: 1, text: "Senior Software Engineer", kind: "paragraph", sectionHint: "identity", bbox: { left: 36, top: 719, width: 165, height: 15 } }),
    createBlock({ id: "a3", pageNumber: 1, readingOrder: 2, text: "Tampa, FL", kind: "contact", sectionHint: "contact", bbox: { left: 537, top: 755, width: 39, height: 9 } }),
    createBlock({ id: "a4", pageNumber: 1, readingOrder: 3, text: "+1 555-010-5538", kind: "contact", sectionHint: "contact", bbox: { left: 513, top: 742, width: 63, height: 9 } }),
    createBlock({ id: "a5", pageNumber: 1, readingOrder: 4, text: "owen.mercer@example.test", kind: "contact", sectionHint: "contact", bbox: { left: 476, top: 729, width: 100, height: 9 } }),
    createBlock({ id: "a6", pageNumber: 1, readingOrder: 5, text: "PROFESSIONAL SUMMARY", kind: "heading", sectionHint: "summary", bbox: { left: 35, top: 674, width: 160, height: 12 } }),
    createBlock({ id: "a7", pageNumber: 1, readingOrder: 6, text: "Experienced Staff Engineer with a focus on leading complex, high-impact initiatives across full-stack systems.", kind: "paragraph", sectionHint: "summary", bbox: { left: 35, top: 652, width: 540, height: 24 } }),
    createBlock({ id: "a8", pageNumber: 1, readingOrder: 7, text: "EXPERIENCE", kind: "heading", sectionHint: "experience", bbox: { left: 35, top: 569, width: 79, height: 12 } }),
    createBlock({ id: "a9", pageNumber: 1, readingOrder: 8, text: "EdSights, Remote, NY — Staff/Senior Software Engineer", kind: "experience_header", sectionHint: "experience", bbox: { left: 35, top: 552, width: 280, height: 12 } }),
    createBlock({ id: "a10", pageNumber: 1, readingOrder: 9, text: "Sep 2021 – Feb 2026", kind: "paragraph", sectionHint: "experience", bbox: { left: 35, top: 533, width: 93, height: 11 } }),
  ],
});

export const RESUME_IMPORT_BENCHMARK_CASE_FIXTURES: Record<string, ResumeDocumentBundle> = {
  elian_pdf: ELIAN_IMPORT_FIXTURE_BUNDLE,
  owen_mercer_pdf: OWEN_IMPORT_FIXTURE_BUNDLE,
};

export function createBenchmarkCaseFromFixture(input: ResumeImportBenchmarkCase): {
  benchmarkCase: ResumeImportBenchmarkCase;
  fixtureBundle: ResumeDocumentBundle | null;
} {
  return {
    benchmarkCase: input,
    fixtureBundle: RESUME_IMPORT_BENCHMARK_CASE_FIXTURES[input.id] ?? null,
  };
}
