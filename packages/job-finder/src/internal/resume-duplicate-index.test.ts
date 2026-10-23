import { expect, test } from "vitest";
import { ResumeDraftBulletSchema } from "@nestor/contracts";
import { createSeed } from "../workspace-service.test-support";
import { seedResumeDraft } from "./resume-workspace-structure";
import {
  areNearDuplicateResumeLines,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import { normalizeText } from "./shared";

test("indexed duplicate warnings agree with the original pairwise rule", () => {
  const seed = createSeed();
  const job = seed.savedJobs[0]!;
  const draft = seedResumeDraft({
    profile: seed.profile,
    job,
    templateId: "classic_ats",
  });
  const lines = [
    "a",
    "A",
    "and the by",
    "and the by",
    "alpha beta gamma",
    "alpha beta gamma delta",
    "delta gamma beta alpha extra",
    "alpha beta gamma epsilon",
    "alpha beta",
    "zeta alpha beta gamma delta eta",
  ];
  for (let index = 0; index < 120; index++) {
    lines.push(
      Array.from(
        { length: 4 + (index % 8) },
        (_, word) => `word${(index * 7 + word * 11) % 31}`,
      ).join(" "),
    );
  }
  const section = {
    ...draft.sections[0]!,
    included: true,
    text: null,
    entries: [],
    bullets: lines.map((text, index) =>
      ResumeDraftBulletSchema.parse({
        id: `bullet-${index}`,
        text,
        included: true,
        locked: false,
        origin: "user_edited",
        updatedAt: draft.updatedAt,
        sourceRefs: [],
      }),
    ),
  };
  const result = validateResumeDraft({
    draft: { ...draft, sections: [section] },
    job,
  });
  const expected = lines.flatMap((text, index) =>
    lines
      .slice(0, index)
      .some(
        (previous) =>
          normalizeText(previous) === normalizeText(text) ||
          areNearDuplicateResumeLines(previous, text),
      )
      ? [`bullet-${index}`]
      : [],
  );
  expect(
    result.issues
      .filter((issue) => issue.category === "duplicate_bullet")
      .map((issue) => issue.bulletId),
  ).toEqual(expected);
});
