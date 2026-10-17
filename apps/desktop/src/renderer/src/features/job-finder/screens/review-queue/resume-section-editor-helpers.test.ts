import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResumeDraftSectionSchema,
  type ResumeDraftBullet,
  type ResumeDraftEntry,
  type ResumeDraftOrigin,
  type ResumeDraftSection,
} from "@nestor/contracts";

import {
  createResumeDraftPatch,
  orderResumeEntriesNewestFirst,
  resetResumeDraftPatchCounter,
  updateEntryBulletText,
  updateEntrySummary,
  updateSectionBulletText,
  updateSectionText,
} from "./resume-section-editor-helpers";

function buildEntry(input: {
  id: string;
  dateRange: string | null;
  sortOrder: number;
  title?: string;
}): ResumeDraftEntry {
  return {
    id: input.id,
    entryType: "experience",
    title: input.title ?? input.id,
    subtitle: "Example Co",
    location: null,
    dateRange: input.dateRange,
    startDate: null,
    endDate: null,
    isCurrent: false,
    summary: null,
    bullets: [],
    origin: "imported",
    locked: false,
    included: true,
    sortOrder: input.sortOrder,
    profileRecordId: input.id,
    sourceRefs: [],
    updatedAt: "2026-05-04T00:00:00.000Z",
  };
}

describe("orderResumeEntriesNewestFirst", () => {
  it("orders DD/MM/YYYY ranges chronologically", () => {
    const ordered = orderResumeEntriesNewestFirst([
      buildEntry({
        id: "older",
        dateRange: "13/12/2018 – 31/07/2019",
        sortOrder: 0,
      }),
      buildEntry({
        id: "current",
        dateRange: "13/07/2023 – Present",
        sortOrder: 1,
      }),
      buildEntry({
        id: "middle",
        dateRange: "14/11/2021 – 30/06/2023",
        sortOrder: 2,
      }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "current",
      "middle",
      "older",
    ]);
  });

  it("treats textual range separators as chronology separators", () => {
    const ordered = orderResumeEntriesNewestFirst([
      buildEntry({
        id: "older",
        dateRange: "Jan 2020 through Feb 2021",
        sortOrder: 0,
      }),
      buildEntry({
        id: "newer",
        dateRange: "Mar 2021 until Apr 2022",
        sortOrder: 1,
      }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(["newer", "older"]);
  });

  it("prefers structured dates over legacy dateRange text", () => {
    const legacyCurrent = buildEntry({
      id: "legacy_current",
      dateRange: "Jan 2020 – Jan 2021",
      sortOrder: 0,
    });
    const structuredNewer = {
      ...buildEntry({
        id: "structured_newer",
        dateRange: "Jan 2020 – Jan 2021",
        sortOrder: 1,
      }),
      startDate: "2025-01",
      endDate: "2025-12",
    };

    const ordered = orderResumeEntriesNewestFirst([
      legacyCurrent,
      structuredNewer,
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "structured_newer",
      "legacy_current",
    ]);
  });
});

describe("createResumeDraftPatch", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetResumeDraftPatchCounter();
  });

  it("can reset generated patch id counters for deterministic tests", () => {
    vi.setSystemTime(new Date("2026-05-04T00:00:00.000Z"));
    resetResumeDraftPatchCounter();

    const firstPatch = createResumeDraftPatch({
      idPrefix: "resume_patch_test",
      operation: "toggle_include",
      sectionId: "section_experience",
    });
    const secondPatch = createResumeDraftPatch({
      idPrefix: "resume_patch_test",
      operation: "toggle_include",
      sectionId: "section_experience",
    });
    resetResumeDraftPatchCounter();
    const resetPatch = createResumeDraftPatch({
      idPrefix: "resume_patch_test",
      operation: "toggle_include",
      sectionId: "section_experience",
    });

    expect(firstPatch.id).toBe("resume_patch_test_1777852800000_1");
    expect(secondPatch.id).toBe("resume_patch_test_1777852800000_2");
    expect(resetPatch.id).toBe(firstPatch.id);
  });
});

const fixtureUpdatedAt = "2026-05-04T00:00:00.000Z";

function buildBullet(id: string, origin: ResumeDraftOrigin): ResumeDraftBullet {
  return {
    id,
    text: `${id} line`,
    origin,
    locked: false,
    included: true,
    sourceRefs: [],
    lastGeneratedContentHash: null,
    updatedAt: fixtureUpdatedAt,
  };
}

function buildSectionWithBullets(input: {
  entries?: readonly ResumeDraftEntry[];
  entryBullets: readonly ResumeDraftBullet[];
  sectionBullets: readonly ResumeDraftBullet[];
}): ResumeDraftSection {
  const entry: ResumeDraftEntry = {
    ...buildEntry({
      id: "entry_1",
      dateRange: "Jan 2020 – Jan 2021",
      sortOrder: 0,
    }),
    bullets: [...input.entryBullets],
  };

  return {
    id: "section_experience",
    kind: "experience",
    label: "Experience",
    text: null,
    bullets: [...input.sectionBullets],
    entries: [...(input.entries ?? [entry])],
    origin: "ai_generated",
    locked: false,
    included: true,
    sortOrder: 0,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: fixtureUpdatedAt,
  };
}

function buildSummarySection(input: {
  origin: ResumeDraftOrigin;
  text: string | null;
}): ResumeDraftSection {
  return {
    id: "section_summary",
    kind: "summary",
    label: "Summary",
    text: input.text,
    bullets: [buildBullet("summary_section_bullet", input.origin)],
    entries: [],
    origin: input.origin,
    locked: false,
    included: true,
    sortOrder: 0,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: fixtureUpdatedAt,
  };
}

function findBullet(
  section: ResumeDraftSection,
  bulletId: string,
): ResumeDraftBullet | undefined {
  return [
    ...section.bullets,
    ...section.entries.flatMap((entry) => entry.bullets),
  ].find((bullet) => bullet.id === bulletId);
}

function findEntry(
  section: ResumeDraftSection,
  entryId: string,
): ResumeDraftEntry | undefined {
  return section.entries.find((entry) => entry.id === entryId);
}

describe("inline bullet text origin transitions", () => {
  it("marks changed AI/deterministic lines as user_edited while untouched lines keep their origin", () => {
    const section = buildSectionWithBullets({
      entryBullets: [
        buildBullet("entry_bullet_ai", "ai_generated"),
        buildBullet("entry_bullet_assistant", "assistant_edited"),
        buildBullet("entry_bullet_user", "user_edited"),
      ],
      sectionBullets: [
        buildBullet("section_bullet_det", "deterministic_fallback"),
        buildBullet("section_bullet_imported", "imported"),
      ],
    });

    const afterEntryEdit = updateEntryBulletText(
      section,
      "entry_1",
      "entry_bullet_ai",
      "Rewritten by hand",
    );
    const editedEntryBullet = findBullet(afterEntryEdit, "entry_bullet_ai");
    expect(editedEntryBullet?.text).toBe("Rewritten by hand");
    expect(editedEntryBullet?.origin).toBe("user_edited");

    const afterAssistantEdit = updateEntryBulletText(
      afterEntryEdit,
      "entry_1",
      "entry_bullet_assistant",
      "entry_bullet_assistant line rewritten",
    );
    expect(
      findBullet(afterAssistantEdit, "entry_bullet_assistant")?.origin,
    ).toBe("user_edited");

    const afterSectionEdit = updateSectionBulletText(
      section,
      "section_bullet_det",
      "Deterministic line rewritten by hand",
    );
    const editedSectionBullet = findBullet(
      afterSectionEdit,
      "section_bullet_det",
    );
    expect(editedSectionBullet?.text).toBe(
      "Deterministic line rewritten by hand",
    );
    expect(editedSectionBullet?.origin).toBe("user_edited");

    // Untouched lines keep their exact objects and origins (no accidental flips).
    expect(findBullet(afterAssistantEdit, "entry_bullet_user")).toBe(
      section.entries[0]?.bullets.find(
        (bullet) => bullet.id === "entry_bullet_user",
      ),
    );
    expect(findBullet(afterAssistantEdit, "entry_bullet_user")?.origin).toBe(
      "user_edited",
    );
    expect(
      findBullet(afterSectionEdit, "section_bullet_imported")?.origin,
    ).toBe("imported");

    // Version behavior is unchanged: timestamps are never touched by inline edits.
    for (const bullet of [
      ...afterSectionEdit.bullets,
      ...afterSectionEdit.entries.flatMap((entry) => entry.bullets),
    ]) {
      expect(bullet.updatedAt).toBe(fixtureUpdatedAt);
    }
    expect(afterSectionEdit.updatedAt).toBe(fixtureUpdatedAt);
  });

  it("keeps origin when the submitted text is unchanged", () => {
    const section = buildSectionWithBullets({
      entryBullets: [buildBullet("entry_bullet_ai", "ai_generated")],
      sectionBullets: [buildBullet("section_bullet_ai", "ai_generated")],
    });
    const originalEntryBullet = section.entries[0]?.bullets[0];
    const originalSectionBullet = section.bullets[0];

    const sameEntryText = updateEntryBulletText(
      section,
      "entry_1",
      "entry_bullet_ai",
      "entry_bullet_ai line",
    );
    expect(findBullet(sameEntryText, "entry_bullet_ai")).toBe(
      originalEntryBullet,
    );

    const sameSectionText = updateSectionBulletText(
      section,
      "section_bullet_ai",
      "section_bullet_ai line",
    );
    expect(findBullet(sameSectionText, "section_bullet_ai")).toBe(
      originalSectionBullet,
    );
  });

  it("keeps later ordinary edits user_edited", () => {
    const section = buildSectionWithBullets({
      entryBullets: [buildBullet("entry_bullet_ai", "ai_generated")],
      sectionBullets: [],
    });

    const firstEdit = updateEntryBulletText(
      section,
      "entry_1",
      "entry_bullet_ai",
      "First rewrite",
    );
    expect(findBullet(firstEdit, "entry_bullet_ai")?.origin).toBe(
      "user_edited",
    );

    const secondEdit = updateEntryBulletText(
      firstEdit,
      "entry_1",
      "entry_bullet_ai",
      "Second ordinary edit",
    );
    expect(findBullet(secondEdit, "entry_bullet_ai")?.text).toBe(
      "Second ordinary edit",
    );
    expect(findBullet(secondEdit, "entry_bullet_ai")?.origin).toBe(
      "user_edited",
    );
  });

  it("marks materially rewritten imported bullets as user_edited while untouched imported lines stay imported", () => {
    const untouchedImportedBullet = buildBullet(
      "entry_bullet_imported_untouched",
      "imported",
    );
    const section = buildSectionWithBullets({
      entryBullets: [
        buildBullet("entry_bullet_imported", "imported"),
        untouchedImportedBullet,
      ],
      sectionBullets: [buildBullet("section_bullet_imported", "imported")],
    });

    const entryEdited = updateEntryBulletText(
      section,
      "entry_1",
      "entry_bullet_imported",
      "Rewritten in my own words",
    );
    const editedEntryBullet = findBullet(entryEdited, "entry_bullet_imported");
    expect(editedEntryBullet?.origin).toBe("user_edited");
    expect(editedEntryBullet?.updatedAt).toBe(fixtureUpdatedAt);
    // Unchanged imported sibling keeps its origin and exact object.
    expect(findBullet(entryEdited, "entry_bullet_imported_untouched")).toBe(
      untouchedImportedBullet,
    );

    const sectionEdited = updateSectionBulletText(
      section,
      "section_bullet_imported",
      "Section bullet rewritten",
    );
    expect(findBullet(sectionEdited, "section_bullet_imported")?.origin).toBe(
      "user_edited",
    );
    expect(findBullet(sectionEdited, "section_bullet_imported")?.text).toBe(
      "Section bullet rewritten",
    );
  });

  it("keeps the save/reload shape valid after an inline edit", () => {
    const section = buildSectionWithBullets({
      entryBullets: [buildBullet("entry_bullet_ai", "ai_generated")],
      sectionBullets: [
        buildBullet("section_bullet_det", "deterministic_fallback"),
      ],
    });

    const edited = updateSectionBulletText(
      updateEntryBulletText(
        section,
        "entry_1",
        "entry_bullet_ai",
        "Hand rewrite",
      ),
      "section_bullet_det",
      "Deterministic hand rewrite",
    );

    const parsed = ResumeDraftSectionSchema.safeParse(edited);
    expect(parsed.success).toBe(true);

    const reloaded = parsed.success ? parsed.data : null;
    expect(
      reloaded?.entries
        .flatMap((entry) => entry.bullets)
        .find((bullet) => bullet.id === "entry_bullet_ai"),
    ).toMatchObject({
      origin: "user_edited",
      text: "Hand rewrite",
    });
    expect(
      reloaded?.bullets.find((bullet) => bullet.id === "section_bullet_det"),
    ).toMatchObject({
      origin: "user_edited",
      text: "Deterministic hand rewrite",
    });
  });
});

describe("inline entry summary and section text origin transitions", () => {
  it("marks changed generated summaries as user_edited while sibling entries keep their objects", () => {
    const generatedEntry: ResumeDraftEntry = {
      ...buildEntry({ id: "entry_generated", dateRange: null, sortOrder: 0 }),
      summary: "Generated summary",
      origin: "ai_generated",
    };
    const userEntry: ResumeDraftEntry = {
      ...buildEntry({ id: "entry_user", dateRange: null, sortOrder: 1 }),
      summary: "User summary",
      origin: "user_edited",
    };
    const section = buildSectionWithBullets({
      entries: [generatedEntry, userEntry],
      entryBullets: [],
      sectionBullets: [],
    });

    const edited = updateEntrySummary(
      section,
      "entry_generated",
      "Hand written summary",
    );
    const editedEntry = findEntry(edited, "entry_generated");
    expect(editedEntry?.summary).toBe("Hand written summary");
    expect(editedEntry?.origin).toBe("user_edited");

    // IDs, evidence refs, locks, and timestamps are never touched.
    expect(editedEntry?.id).toBe(generatedEntry.id);
    expect(editedEntry?.sourceRefs).toBe(generatedEntry.sourceRefs);
    expect(editedEntry?.locked).toBe(false);
    expect(editedEntry?.updatedAt).toBe(fixtureUpdatedAt);

    // Untouched sibling keeps its exact object (no accidental origin flips).
    expect(findEntry(edited, "entry_user")).toBe(userEntry);

    // Ordinary later edits stay user_edited.
    const reedited = updateEntrySummary(
      edited,
      "entry_generated",
      "Another ordinary edit",
    );
    expect(findEntry(reedited, "entry_generated")?.summary).toBe(
      "Another ordinary edit",
    );
    expect(findEntry(reedited, "entry_generated")?.origin).toBe("user_edited");
  });

  it("preserves the entry object when the submitted summary is unchanged", () => {
    const fallbackEntry: ResumeDraftEntry = {
      ...buildEntry({ id: "entry_fallback", dateRange: null, sortOrder: 0 }),
      summary: null,
      origin: "deterministic_fallback",
    };
    const section = buildSectionWithBullets({
      entries: [fallbackEntry],
      entryBullets: [],
      sectionBullets: [],
    });

    // Null-to-null summary keeps the exact entry object and origin.
    const sameNull = updateEntrySummary(section, "entry_fallback", null);
    expect(findEntry(sameNull, "entry_fallback")).toBe(fallbackEntry);
    expect(findEntry(sameNull, "entry_fallback")?.origin).toBe(
      "deterministic_fallback",
    );

    // Identical non-null summary keeps the exact entry object and origin.
    const assistantEntry: ResumeDraftEntry = {
      ...fallbackEntry,
      id: "entry_assistant",
      summary: "Existing wording",
      origin: "assistant_edited",
    };
    const withSummarySection = buildSectionWithBullets({
      entries: [assistantEntry],
      entryBullets: [],
      sectionBullets: [],
    });

    const sameText = updateEntrySummary(
      withSummarySection,
      "entry_assistant",
      "Existing wording",
    );
    expect(findEntry(sameText, "entry_assistant")).toBe(assistantEntry);
    expect(findEntry(sameText, "entry_assistant")?.origin).toBe(
      "assistant_edited",
    );
  });

  it("treats adding or clearing a summary as a material provenance change", () => {
    const fallbackEntry: ResumeDraftEntry = {
      ...buildEntry({ id: "entry_fallback", dateRange: null, sortOrder: 0 }),
      origin: "deterministic_fallback",
    };
    const assistantEntry: ResumeDraftEntry = {
      ...buildEntry({ id: "entry_assistant", dateRange: null, sortOrder: 1 }),
      summary: "Assistant wording",
      origin: "assistant_edited",
    };
    const section = buildSectionWithBullets({
      entries: [fallbackEntry, assistantEntry],
      entryBullets: [],
      sectionBullets: [],
    });

    const added = updateEntrySummary(
      section,
      "entry_fallback",
      "Freshly typed summary",
    );
    expect(findEntry(added, "entry_fallback")?.summary).toBe(
      "Freshly typed summary",
    );
    expect(findEntry(added, "entry_fallback")?.origin).toBe("user_edited");

    const cleared = updateEntrySummary(section, "entry_assistant", null);
    expect(findEntry(cleared, "entry_assistant")?.summary).toBeNull();
    expect(findEntry(cleared, "entry_assistant")?.origin).toBe("user_edited");
  });

  it("marks changed section text as user_edited and preserves the section when text is identical", () => {
    const section = buildSummarySection({
      origin: "ai_generated",
      text: "Generated overview",
    });
    const untouchedBullet = section.bullets[0];

    const edited = updateSectionText(section, "Hand written overview");
    expect(edited.text).toBe("Hand written overview");
    expect(edited.origin).toBe("user_edited");
    expect(edited.id).toBe(section.id);
    expect(edited.updatedAt).toBe(fixtureUpdatedAt);

    // Untouched bullet keeps its exact object; identical text returns the
    // same section object with its origin preserved.
    expect(edited.bullets[0]).toBe(untouchedBullet);
    expect(updateSectionText(edited, "Hand written overview")).toBe(edited);
    expect(updateSectionText(section, "Generated overview")).toBe(section);

    // Ordinary later edits stay user_edited.
    const reedited = updateSectionText(edited, "Another ordinary edit");
    expect(reedited.origin).toBe("user_edited");
  });

  it("marks materially rewritten imported summary and section text as user_edited", () => {
    const importedSummaryEntry: ResumeDraftEntry = {
      ...buildEntry({
        id: "entry_imported_summary",
        dateRange: null,
        sortOrder: 0,
      }),
      summary: "Imported summary wording",
      origin: "imported",
    };
    const section = {
      ...buildSectionWithBullets({
        entries: [importedSummaryEntry],
        entryBullets: [],
        sectionBullets: [],
      }),
      text: "Imported overview",
    };

    const summaryEdited = updateEntrySummary(
      section,
      "entry_imported_summary",
      "Rewritten summary wording",
    );
    expect(findEntry(summaryEdited, "entry_imported_summary")?.summary).toBe(
      "Rewritten summary wording",
    );
    expect(findEntry(summaryEdited, "entry_imported_summary")?.origin).toBe(
      "user_edited",
    );

    const sectionEdited = updateSectionText(section, "Rewritten overview");
    expect(sectionEdited.origin).toBe("user_edited");
    expect(sectionEdited.text).toBe("Rewritten overview");
  });

  it("keeps the save/reload shape valid after summary and section text edits", () => {
    const section: ResumeDraftSection = {
      ...buildSummarySection({
        origin: "ai_generated",
        text: "Generated overview",
      }),
      entries: [
        {
          ...buildEntry({
            id: "entry_summary_only",
            dateRange: null,
            sortOrder: 0,
          }),
          summary: "Generated summary line",
          origin: "deterministic_fallback",
        },
      ],
    };

    const edited = updateSectionText(
      updateEntrySummary(section, "entry_summary_only", "Hand written summary"),
      "Hand written overview",
    );

    const parsed = ResumeDraftSectionSchema.safeParse(edited);
    expect(parsed.success).toBe(true);

    const reloaded = parsed.success ? parsed.data : null;
    expect(reloaded?.origin).toBe("user_edited");
    expect(
      reloaded?.entries.find((entry) => entry.id === "entry_summary_only"),
    ).toMatchObject({
      origin: "user_edited",
      summary: "Hand written summary",
    });
  });
});
