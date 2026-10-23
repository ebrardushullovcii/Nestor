import { expect, test } from "vitest";
import { assessJobPostingDetailQuality } from "./discovery";

type Input = Parameters<typeof assessJobPostingDetailQuality>[0];
function previous(input: Input) {
  const normalize = (value: string) =>
    value.replace(/\s+/gu, " ").trim().toLowerCase();
  const description = input.description.trim();
  const words = description.trim().split(/\s+/u).filter(Boolean).length;
  const details = [
    ...input.responsibilities,
    ...input.minimumQualifications,
    ...input.preferredQualifications,
    ...input.benefits,
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const characters = details.reduce((total, value) => total + value.length, 0);
  const synthetic = [
    normalize(input.title),
    `${normalize(input.title)} role at ${normalize(input.company)}`,
    `${normalize(input.title)} opportunity at ${normalize(input.company)}`,
  ].includes(normalize(description));
  if (
    (!synthetic && (words >= 70 || description.length >= 500)) ||
    (!synthetic && words >= 35 && details.length >= 2) ||
    (details.length >= 5 && characters >= 180)
  )
    return "detail_enriched";
  if (
    (!synthetic && words >= 18) ||
    details.length > 0 ||
    input.keySkills.length >= 2
  )
    return "partial_detail";
  return "card_only";
}

test("bounded word counting preserves the old classification at every threshold and for synthetic text", () => {
  for (const title of ["Engineer", "very long title ".repeat(50)])
    for (const company of ["Example", "company name ".repeat(50)])
      for (const description of [
        "",
        title,
        `${title} role at ${company}`,
        `${title} opportunity at ${company}`,
        ...[1, 17, 18, 34, 35, 69, 70, 71, 2000].map((n) =>
          "word\u00a0\n".repeat(n),
        ),
      ])
        for (const structured of [
          [],
          ["Requirement"],
          Array.from({ length: 5 }, () => "Structured requirement ".repeat(3)),
        ]) {
          const input: Input = {
            title,
            company,
            description,
            keySkills: [],
            responsibilities: structured,
            minimumQualifications: [],
            preferredQualifications: [],
            benefits: [],
          };
          expect(assessJobPostingDetailQuality(input)).toBe(previous(input));
        }
});
