import { describe, expect, it } from "vitest";
import { ResumeDraftSchema } from "@nestor/contracts";
import { createSeed } from "../test-fixtures";
import { balanceResumePages } from "./balance-resume-pages";

function fixture(shown: number, total: number) {
  const profile = createSeed().profile;
  const achievements = Array.from(
    { length: total },
    (_, n) =>
      `Delivered unique work package ${n + 1} for a synthetic customer.`,
  );
  profile.experiences[0]!.achievements = achievements;
  const draft = ResumeDraftSchema.parse({
    id: "draft",
    status: "draft",
    jobId: "job",
    templateId: "classic_ats",
    createdAt: "2026-10-29T00:00:00Z",
    updatedAt: "2026-10-29T00:00:00Z",
    sections: [
      {
        id: "experience",
        origin: "imported",
        sortOrder: 0,
        kind: "experience",
        label: "Experience",
        included: true,
        entries: [
          {
            id: "role",
            origin: "imported",
            sortOrder: 0,
            entryType: "experience",
            included: true,
            title: "Engineer",
            bullets: achievements.map((text, n) => ({
              id: `b${n}`,
              text,
              included: n < shown,
              origin: "imported",
              updatedAt: "2026-10-29T00:00:00Z",
            })),
            updatedAt: "2026-10-29T00:00:00Z",
          },
        ],
        updatedAt: "2026-10-29T00:00:00Z",
      },
    ],
  });
  return { profile, draft };
}
const count = (draft: ReturnType<typeof fixture>["draft"]) =>
  draft.sections
    .filter((s) => s.included)
    .flatMap((s) =>
      s.entries
        .filter((e) => e.included)
        .flatMap((e) => e.bullets.filter((b) => b.included)),
    ).length;
const measure = (draft: ReturnType<typeof fixture>["draft"]) => {
  const n = count(draft);
  return Promise.resolve({
    pageCount: Math.max(1, Math.ceil(n / 10)),
    lastPageFillRatio: n <= 10 ? n / 10 : (n % 10 || 10) / 10,
  });
};
describe("final resume page balance", () => {
  it("restores real hidden material to a substantial second page", async () => {
    const input = fixture(5, 18);
    const result = await balanceResumePages({ ...input, measure });
    expect(count(result)).toBe(18);
    expect(await measure(result)).toEqual({
      pageCount: 2,
      lastPageFillRatio: 0.8,
    });
    expect(count(input.draft)).toBe(5);
  });
  it("returns to one full page when all real material leaves a short second page", async () => {
    const result = await balanceResumePages({ ...fixture(8, 13), measure });
    expect(count(result)).toBe(10);
  });
  it("never keeps more than two pages", async () => {
    const result = await balanceResumePages({ ...fixture(28, 28), measure });
    expect(count(result)).toBe(20);
  });
  it("does not restore unsupported generated content", async () => {
    const input = fixture(5, 8);
    for (const bullet of input.draft.sections[0]!.entries[0]!.bullets.slice(
      5,
    )) {
      bullet.origin = "ai_generated";
      bullet.text = "Invented achievement outside the profile.";
    }
    expect(count(await balanceResumePages({ ...input, measure }))).toBe(5);
  });
  it("keeps scarce real material without padding", async () => {
    expect(count(await balanceResumePages({ ...fixture(3, 3), measure }))).toBe(
      3,
    );
  });
});
