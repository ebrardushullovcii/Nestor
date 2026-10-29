import type { CandidateProfile, ResumeDraft } from "@nestor/contracts";
import {
  buildPersonsOwnResumeClaimMatcher,
  resumeClaimContentHash,
} from "../internal/resume-workspace-helpers";

type Layout = { pageCount?: number | null; lastPageFillRatio?: number | null };

/** Only saved facts fill spare room. All edits are reversible visibility edits. */
export async function balanceResumePages(input: {
  draft: ResumeDraft;
  profile: CandidateProfile;
  measure: (draft: ResumeDraft) => Promise<Layout>;
}): Promise<ResumeDraft> {
  const own = buildPersonsOwnResumeClaimMatcher(input);
  const draft = structuredClone(input.draft);
  const hidden = draft.sections
    .filter((section) => section.included)
    .flatMap((section) =>
      section.entries
        .filter((entry) => entry.included)
        .flatMap((entry) =>
          entry.bullets.filter(
            (bullet) =>
              !bullet.included &&
              !bullet.locked &&
              own({
                text: bullet.text,
                origin: bullet.origin,
                field: "entry_bullet",
                sectionId: section.id,
              }),
          ),
        ),
    );
  const visible = new Set(
    draft.sections
      .filter((s) => s.included)
      .flatMap((s) =>
        s.entries
          .filter((e) => e.included)
          .flatMap((e) =>
            e.bullets
              .filter((b) => b.included)
              .map((b) => resumeClaimContentHash(b.text)),
          ),
      ),
  );
  const coveredAchievements = new Set(
    draft.sections
      .filter((s) => s.included)
      .flatMap((s) =>
        s.entries
          .filter((e) => e.included)
          .flatMap((e) =>
            e.bullets
              .filter((b) => b.included)
              .flatMap((b) =>
                b.sourceRefs
                  .map((ref) => ref.sourceId)
                  .filter((id): id is string =>
                    Boolean(id?.match(/^experience:.+:achievement:\d+$/u)),
                  ),
              ),
          ),
      ),
  );
  const candidates = hidden
    .filter((bullet) => {
      const hash = resumeClaimContentHash(bullet.text);
      if (
        visible.has(hash) ||
        bullet.sourceRefs.some(
          (ref) => ref.sourceId && coveredAchievements.has(ref.sourceId),
        )
      )
        return false;
      visible.add(hash);
      return true;
    })
    .sort((a, b) => Number(/\d/u.test(b.text)) - Number(/\d/u.test(a.text)));
  const setCount = (count: number) =>
    candidates.forEach((bullet, index) => {
      bullet.included = index < count;
    });
  let layout = await input.measure(draft);
  if (layout.pageCount == null) return draft;
  // Find the largest prefix of saved achievements that fits two pages. A
  // binary search bounds render work even for a long imported history.
  let count = 0;
  if (layout.pageCount <= 2 && candidates.length) {
    let low = 0;
    let high = candidates.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      setCount(middle);
      const measured = await input.measure(draft);
      if (measured.pageCount == null) {
        setCount(count);
        return draft;
      }
      if (measured.pageCount <= 2) {
        low = middle;
        count = middle;
      } else high = middle - 1;
    }
    setCount(count);
    layout = await input.measure(draft);
  }
  const sparseLastPage = () =>
    layout.pageCount === 2 &&
    layout.lastPageFillRatio != null &&
    layout.lastPageFillRatio < 0.5;
  if ((layout.pageCount ?? 0) <= 2 && !sparseLastPage()) return draft;
  const target = sparseLastPage() ? 1 : 2;
  // Lowest-value prose goes first; metric evidence survives ahead of it.
  // Keep one bullet per role until other available material is exhausted.
  const entries = draft.sections
    .filter((s) => s.included)
    .flatMap((s) => s.entries.filter((e) => e.included))
    .reverse();
  const removals: Array<(candidate: ResumeDraft) => void> = [];
  const extras = entries
    .flatMap((entry) =>
      entry.bullets.filter((b) => b.included && !b.locked).slice(1),
    )
    .sort((a, b) => Number(/\d/u.test(a.text)) - Number(/\d/u.test(b.text)));
  for (const bullet of extras)
    removals.push((candidate) => {
      for (const section of candidate.sections)
        for (const entry of section.entries) {
          const target = entry.bullets.find((item) => item.id === bullet.id);
          if (target) target.included = false;
        }
    });
  for (const entry of entries)
    if (!entry.locked)
      removals.push((candidate) => {
        for (const section of candidate.sections) {
          const target = section.entries.find((item) => item.id === entry.id);
          if (target) target.included = false;
        }
      });
  for (const section of [...draft.sections].reverse())
    if (section.included && !section.locked && section.kind !== "summary")
      removals.push((candidate) => {
        candidate.sections.find((item) => item.id === section.id)!.included =
          false;
      });
  // Search cumulative visibility changes, measuring the resulting PDF rather
  // than guessing from years of experience or character counts.
  let low = 0;
  let high = removals.length;
  const full = structuredClone(draft);
  const apply = (n: number) => {
    draft.sections = structuredClone(full.sections);
    for (const remove of removals.slice(0, n)) remove(draft);
  };
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    apply(middle);
    const measured = await input.measure(draft);
    if (measured.pageCount == null) return input.draft;
    if (measured.pageCount <= target) high = middle;
    else low = middle + 1;
  }
  apply(low);
  layout = await input.measure(draft);
  // Trimming a three-page resume may expose a short second page; finish at
  // one page using the same saved content and never pad it with invented text.
  if (target === 2 && sparseLastPage())
    return balanceResumePages({ ...input, draft });
  if ((layout.pageCount ?? 0) > 2)
    throw new Error("The resume could not fit within two pages.");
  return draft;
}
