import { ResumeDocumentBundleSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { extractLiteralCandidates } from "./resume-import-literal-extraction";

const createdAt = "2026-09-15T09:00:00.000Z";

function bundle(fullText: string) {
  return ResumeDocumentBundleSchema.parse({
    id: "bundle_test",
    runId: "run_test",
    sourceResumeId: "resume_test",
    sourceFileKind: "pdf",
    primaryParserKind: "pdfjs_text",
    createdAt,
    fullText,
    blocks: fullText.split("\n").map((text, index) => ({
      id: `block_${index}`,
      pageNumber: 1,
      kind: text.includes("2016") ? "experience_header" : "contact",
      sectionHint: text.includes("2016") ? "experience" : "contact",
      text,
      readingOrder: index,
    })),
  });
}

describe("literal resume phone extraction", () => {
  test("does not turn an employment date range into a phone number", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle(
        "Alex Vanguard\nProduct Designer | Northstar Studio | 2016 - 2020",
      ),
      createdAt,
    );

    expect(
      candidates.find((candidate) => candidate.target.key === "phone"),
    ).toBeUndefined();
  });

  test("keeps a short local phone number and its extension", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle("Alex Vanguard\n5555 0198 ext. 42"),
      createdAt,
    );

    expect(
      candidates.find((candidate) => candidate.target.key === "phone")?.value,
    ).toBe("5555 0198 ext. 42");
  });
});

describe("literal resume header work-mode extraction", () => {
  test("keeps an explicit remote preference when the model omits it", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle(
        "Morgan Lee\nRemote, Berlin, Germany | morgan@example.test\nProduct Engineer\nExperience\nRemote collaboration across three countries",
      ),
      createdAt,
    );

    expect(
      candidates.find(
        (candidate) =>
          candidate.target.section === "search_preferences" &&
          candidate.target.key === "workModes",
      ),
    ).toMatchObject({
      value: ["remote"],
      resolution: "auto_applied",
      notes: ["explicit_header_work_mode"],
    });
  });

  test("does not treat remote work in an experience description as a preference", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle(
        "Morgan Lee\nBerlin, Germany | morgan@example.test\nProduct Engineer\nExperience\nLed a remote team across three countries",
      ),
      createdAt,
    );

    expect(
      candidates.find(
        (candidate) => candidate.target.key === "workModes",
      ),
    ).toBeUndefined();
  });

  test.each([
    "Morgan Lee\nNot open to remote work\nProduct Engineer",
    "Morgan Lee\nFlexible Engineer\nBerlin, Germany",
  ])("does not guess a work preference from %s", (fullText) => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle(fullText),
      createdAt,
    );

    expect(
      candidates.find(
        (candidate) => candidate.target.key === "workModes",
      ),
    ).toBeUndefined();
  });

  test("stops at a section heading inside a multiline block", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle(
        "Morgan Lee\nBerlin, Germany\nProduct Engineer\nExperience\nRemote collaboration across three countries",
      ),
      createdAt,
    );

    expect(
      candidates.find(
        (candidate) => candidate.target.key === "workModes",
      ),
    ).toBeUndefined();
  });

  test("reads an explicit remote preference after the header location", () => {
    const candidates = extractLiteralCandidates(
      "run_test",
      bundle("Morgan Lee\nBerlin, Germany | Remote\nProduct Engineer"),
      createdAt,
    );

    expect(
      candidates.find(
        (candidate) => candidate.target.key === "workModes",
      )?.value,
    ).toEqual(["remote"]);
  });
});
