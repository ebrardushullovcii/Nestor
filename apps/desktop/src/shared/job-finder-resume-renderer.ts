import type {
  JobFinderSettings,
  ResumePreviewIdentityField,
  ResumeTemplateId,
} from "@nestor/contracts";
import {
  getResumeEntryBulletTargetId,
  getResumeEntryFieldTargetId,
  getResumeIdentityTargetId,
  getResumeSectionBulletTargetId,
  getResumeSectionTextTargetId,
} from "@nestor/contracts";
import type { ResumeRenderDocument } from "@nestor/job-finder";

import { getLocalResumeTemplateDefinition } from "./job-finder-resume-catalog";

type RenderSection = ResumeRenderDocument["sections"][number];

interface ResumeRenderHtmlOptions {
  catalogLayout?: "thumbnail" | "panel";
  mode?: "catalog" | "export" | "preview";
}

type RenderMode = NonNullable<ResumeRenderHtmlOptions["mode"]>;

function withPreviewSelection(input: {
  mode: "catalog" | "export" | "preview";
  sectionId?: string | null;
  entryId?: string | null;
  targetId?: string | null;
}) {
  return {
    mode: input.mode,
    ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
    ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
    ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function sanitizeSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function formatFontFamily(fontPreset: JobFinderSettings["fontPreset"]): string {
  if (fontPreset === "space_grotesk_display") {
    return "'Space Grotesk', 'Trebuchet MS', 'Segoe UI', sans-serif";
  }

  return "'IBM Plex Sans', 'Segoe UI', sans-serif";
}

function formatContactItem(value: string): string {
  return value
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "");
}

function formatDateSegment(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (/^(present|current|now|ongoing)$/i.test(trimmed)) {
    return "Present";
  }

  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const monthByName: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };
  const formatMonthYear = (monthNumber: number, year: string) => {
    const month = monthNames[monthNumber - 1];

    return month ? `${month} ${year}` : null;
  };

  const yearMonthMatch = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(trimmed);
  if (yearMonthMatch) {
    return formatMonthYear(Number(yearMonthMatch[2]), yearMonthMatch[1] ?? "");
  }

  const monthYearSlashMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (monthYearSlashMatch) {
    return formatMonthYear(
      Number(monthYearSlashMatch[1]),
      monthYearSlashMatch[2] ?? "",
    );
  }

  const dayMonthYearSlashMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(
    trimmed,
  );
  if (dayMonthYearSlashMatch) {
    return formatMonthYear(
      Number(dayMonthYearSlashMatch[2]),
      dayMonthYearSlashMatch[3] ?? "",
    );
  }

  const namedMonthMatch = /^([a-zA-Z]+)\.?\s+(\d{4})$/.exec(trimmed);
  if (namedMonthMatch) {
    const month = monthByName[namedMonthMatch[1]?.toLowerCase() ?? ""] ?? null;

    return month ? formatMonthYear(month, namedMonthMatch[2] ?? "") : trimmed;
  }

  return trimmed;
}

function normalizeDisplayDateRange(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const parts = trimmed
    .split(/\s*[–—]\s*|\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    const rawStart = parts[0] ?? trimmed;
    const rawEnd = parts.at(-1) ?? trimmed;
    const start = formatDateSegment(rawStart) ?? rawStart;
    const end = formatDateSegment(rawEnd) ?? rawEnd;
    return start === end ? start : `${start} – ${end}`;
  }

  return formatDateSegment(trimmed) ?? trimmed;
}

function formatEntryDateRange(input: {
  dateRange: string | null;
  endDate?: string | null | undefined;
  isCurrent?: boolean | undefined;
  startDate?: string | null | undefined;
}): string | null {
  const displayDateRange = normalizeDisplayDateRange(input.dateRange);
  if (displayDateRange) {
    return displayDateRange;
  }

  const start = formatDateSegment(input.startDate);
  const end = input.isCurrent ? "Present" : formatDateSegment(input.endDate);

  if (start && end) {
    return start === end ? start : `${start} – ${end}`;
  }

  return start ?? end ?? null;
}

function getEntryDateTargetField(input: {
  dateRange: string | null;
  endDate?: string | null | undefined;
  isCurrent?: boolean | undefined;
  startDate?: string | null | undefined;
}) {
  if (input.startDate?.trim() || input.dateRange?.trim()) {
    return "startDate";
  }

  if (input.endDate?.trim()) {
    return "endDate";
  }

  return input.isCurrent ? "isCurrent" : "startDate";
}

function renderIdentityFieldTag(input: {
  mode: ResumeRenderHtmlOptions["mode"];
  field: ResumePreviewIdentityField;
  tagName: "h1" | "p" | "span" | "li";
  className?: string;
  text: string;
}): string {
  return `<${input.tagName}${input.className ? ` class="${input.className}"` : ""}${renderPreviewAttributes(
    {
      ...withPreviewSelection({
        mode: input.mode ?? "export",
        targetId: getResumeIdentityTargetId(input.field),
      }),
    },
  )}>${escapeHtml(input.text)}</${input.tagName}>`;
}

function renderEntryHeading(input: {
  title: string | null;
  subtitle: string | null;
  location: string | null;
  dateRange: string | null;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  isCurrent?: boolean | undefined;
  heading: string | null;
  mode: ResumeRenderHtmlOptions["mode"];
  sectionId: string;
  entryId: string;
}): string {
  const primaryParts = [
    input.title
      ? `<span${renderPreviewAttributes({
          ...withPreviewSelection({
            mode: input.mode ?? "export",
            sectionId: input.sectionId,
            entryId: input.entryId,
            targetId: getResumeEntryFieldTargetId(
              input.sectionId,
              input.entryId,
              "title",
            ),
          }),
        })}>${escapeHtml(input.title)}</span>`
      : null,
    input.subtitle
      ? `<span${renderPreviewAttributes({
          ...withPreviewSelection({
            mode: input.mode ?? "export",
            sectionId: input.sectionId,
            entryId: input.entryId,
            targetId: getResumeEntryFieldTargetId(
              input.sectionId,
              input.entryId,
              "subtitle",
            ),
          }),
        })}>${escapeHtml(input.subtitle)}</span>`
      : null,
  ].filter((value): value is string => Boolean(value));
  const displayDateRange = formatEntryDateRange(input);
  const metaParts = [
    input.location
      ? `<span${renderPreviewAttributes({
          ...withPreviewSelection({
            mode: input.mode ?? "export",
            sectionId: input.sectionId,
            entryId: input.entryId,
            targetId: getResumeEntryFieldTargetId(
              input.sectionId,
              input.entryId,
              "location",
            ),
          }),
        })}>${escapeHtml(input.location)}</span>`
      : null,
    displayDateRange
      ? `<span${renderPreviewAttributes({
          ...withPreviewSelection({
            mode: input.mode ?? "export",
            sectionId: input.sectionId,
            entryId: input.entryId,
            targetId: getResumeEntryFieldTargetId(
              input.sectionId,
              input.entryId,
              getEntryDateTargetField(input),
            ),
          }),
        })}>${escapeHtml(displayDateRange)}</span>`
      : null,
  ].filter((value): value is string => Boolean(value));

  if (primaryParts.length === 0) {
    if (!input.heading) {
      return "";
    }

    return `<h4><span class="entry-primary"><span${renderPreviewAttributes({
      ...withPreviewSelection({
        mode: input.mode ?? "export",
        sectionId: input.sectionId,
        entryId: input.entryId,
        targetId: getResumeEntryFieldTargetId(
          input.sectionId,
          input.entryId,
          "title",
        ),
      }),
    })}>${escapeHtml(input.heading)}</span></span></h4>`;
  }

  // A pipe between "Remote, CA" and a date range renders as a lowercase "l"
  // in the serif faces these templates use, so the exported PDF read
  // "Remote, CA l Dec 2021 - Feb 2026". A middot cannot be mistaken for a
  // letter at any resume size.
  return `<h4><span class="entry-primary">${primaryParts.join(' <span aria-hidden="true">—</span> ')}</span>${metaParts.length > 0 ? `<span class="entry-meta">${metaParts.join(' <span aria-hidden="true">·</span> ')}</span>` : ""}</h4>`;
}

function renderPreviewAttributes(input: {
  mode: ResumeRenderHtmlOptions["mode"];
  sectionId?: string | null;
  entryId?: string | null;
  targetId?: string | null;
}): string {
  if (input.mode !== "preview") {
    return "";
  }

  const attributes: string[] = [];

  if (input.sectionId) {
    attributes.push(`data-resume-section-id="${escapeHtml(input.sectionId)}"`);
  }

  if (input.entryId) {
    attributes.push(`data-resume-entry-id="${escapeHtml(input.entryId)}"`);
  }

  if (input.targetId) {
    attributes.push(`data-resume-target-id="${escapeHtml(input.targetId)}"`);
  }

  if (attributes.length > 0) {
    attributes.push('role="button"');
    attributes.push('tabindex="0"');
  }

  return attributes.length > 0 ? ` ${attributes.join(" ")}` : "";
}

const INLINE_BULLET_GLYPH_CLASS = "●•▪◦‣";
const INLINE_BULLET_GLYPH_PATTERN = new RegExp(
  `[${INLINE_BULLET_GLYPH_CLASS}]`,
  "g",
);
const LEADING_BULLET_GLYPH_PATTERN = new RegExp(
  `^[\\s${INLINE_BULLET_GLYPH_CLASS}\\-–—*]+`,
);
const INLINE_BULLET_SPLIT_PATTERN = new RegExp(
  `\\s*[${INLINE_BULLET_GLYPH_CLASS}]\\s*`,
);
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?])\s+(?=["'([A-Z0-9])/;
const LEAD_SENTENCE_BUDGET = 160;

/**
 * Imported resumes routinely split the .NET family across a space
 * ("ASP .NET Core") or drop the space after a list comma ("C#,.NET"), so
 * the same stack reads as a different token in the bullets than in the
 * skills line. Both a recruiter and a keyword-matching ATS see the
 * mismatch, so normalize the spacing deterministically at render time for
 * the preview and the export alike.
 */
export function normalizeResumeTokenSpacing(value: string): string {
  return (
    value
      // "ASP .NET" / "VB .Net" / "ADO .NET" are one token.
      .replace(
        /\b(ASP|VB|ADO)\s+\.(NET)\b/gi,
        (_match, prefix: string, suffix: string) => `${prefix}.${suffix}`,
      )
      // A list comma always takes one following space. Digits are skipped so
      // thousands separators ("1,000") stay intact.
      .replace(/,(?![\s\d])/g, ", ")
      .replace(/[ \t]{2,}/g, " ")
  );
}

/**
 * Bullet glyphs are layout, not content: the list style paints its own
 * marker, so a glyph left inside the text would print twice.
 */
export function stripBulletGlyphs(value: string): string {
  return normalizeResumeTokenSpacing(value)
    .replace(LEADING_BULLET_GLYPH_PATTERN, "")
    .replace(INLINE_BULLET_GLYPH_PATTERN, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function ensureTerminalPunctuation(value: string): string {
  return value.length === 0 || /[\p{Sentence_Terminal}…]$/u.test(value)
    ? value
    : `${value}.`;
}

/**
 * Legacy profiles carry inline "● item ● item" lists or long paragraphs in
 * an entry summary while the entry has no real bullets. Present that text as
 * bullets with at most one short lead sentence. Derived bullets keep the
 * summary as their preview target so clicking one still opens the summary
 * field in the editor.
 */
export function presentEntryNarrative(entry: {
  summary: string | null;
  bullets: ReadonlyArray<{ id: string; text: string }>;
}): {
  summary: string | null;
  bullets: Array<{ id: string; text: string; derivedFromSummary?: boolean }>;
} {
  const cleanedBullets = entry.bullets
    .map((bullet) => ({
      ...bullet,
      // Imported bullets arrive as fragments without terminal punctuation,
      // so a rendered list mixed complete sentences with dangling ones.
      text: ensureTerminalPunctuation(stripBulletGlyphs(bullet.text)),
    }))
    .filter((bullet) => bullet.text.length > 0);
  const summary = entry.summary?.trim() ?? "";
  if (!summary) {
    return { summary: null, bullets: cleanedBullets };
  }

  const glyphCount = summary.match(INLINE_BULLET_GLYPH_PATTERN)?.length ?? 0;
  let lead: string | null = null;
  let derived: string[] = [];

  if (glyphCount >= 2) {
    const startsWithGlyph = new RegExp(
      `^[\\s${INLINE_BULLET_GLYPH_CLASS}]`,
    ).test(summary);
    const segments = summary
      .split(INLINE_BULLET_SPLIT_PATTERN)
      .map(stripBulletGlyphs)
      .filter(Boolean);
    const [first, ...rest] = segments;
    if (
      !startsWithGlyph &&
      first !== undefined &&
      first.length <= LEAD_SENTENCE_BUDGET
    ) {
      lead = ensureTerminalPunctuation(first);
      derived = rest;
    } else {
      derived = segments;
    }
  } else if (cleanedBullets.length < 2) {
    const sentences = summary
      .split(SENTENCE_BOUNDARY_PATTERN)
      .map((sentence) => sentence.trim())
      .filter(Boolean);
    if (sentences.length >= 3) {
      const [first, ...rest] = sentences;
      if (first !== undefined && first.length <= LEAD_SENTENCE_BUDGET) {
        lead = first;
        derived = rest;
      } else {
        derived = sentences;
      }
    } else {
      return { summary: stripBulletGlyphs(summary), bullets: cleanedBullets };
    }
  } else {
    return { summary: stripBulletGlyphs(summary), bullets: cleanedBullets };
  }

  const seen = new Set(
    cleanedBullets.map((bullet) => bullet.text.toLowerCase()),
  );
  const derivedBullets = derived
    .map((text) => ensureTerminalPunctuation(stripBulletGlyphs(text)))
    .filter((text) => {
      const key = text.toLowerCase();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((text, index) => ({
      id: `summary-line-${index + 1}`,
      text,
      derivedFromSummary: true,
    }));

  return {
    summary: lead,
    bullets: [...derivedBullets, ...cleanedBullets],
  };
}

function renderStructuredSection(input: {
  sectionId?: string;
  title: string;
  className?: string;
  mode?: "catalog" | "export" | "preview";
  text?: string | null;
  bullets?: ReadonlyArray<{ id: string; text: string }>;
  entries?: ReadonlyArray<{
    id: string;
    title: string | null;
    subtitle: string | null;
    location: string | null;
    dateRange: string | null;
    startDate?: string | null;
    endDate?: string | null;
    isCurrent?: boolean;
    heading: string | null;
    summary: string | null;
    bullets: Array<{ id: string; text: string }>;
  }>;
}): string {
  const bullets = (input.bullets ?? [])
    .map((bullet) => ({
      ...bullet,
      text: ensureTerminalPunctuation(stripBulletGlyphs(bullet.text)),
    }))
    .filter((bullet) => bullet.text.length > 0);
  const entries = (input.entries ?? []).map((entry) => ({
    ...entry,
    ...presentEntryNarrative(entry),
  }));
  const hasContent =
    Boolean(input.text) || bullets.length > 0 || entries.length > 0;

  if (!hasContent) {
    return "";
  }

  return `
    <section class="section-block${input.className ? ` ${input.className}` : ""}"${renderPreviewAttributes(
      {
        ...withPreviewSelection({
          mode: input.mode ?? "export",
          sectionId: input.sectionId ?? null,
        }),
      },
    )}>
      <h3>${escapeHtml(input.title)}</h3>
      ${
        input.text
          ? `<p${renderPreviewAttributes({
              ...withPreviewSelection({
                mode: input.mode ?? "export",
                sectionId: input.sectionId ?? null,
                targetId: input.sectionId
                  ? getResumeSectionTextTargetId(input.sectionId)
                  : null,
              }),
            })}>${escapeHtml(
              ensureTerminalPunctuation(
                normalizeResumeTokenSpacing(input.text).trim(),
              ),
            )}</p>`
          : ""
      }
      ${entries
        .map(
          (entry) => `
            <article class="entry-block"${renderPreviewAttributes({
              ...withPreviewSelection({
                mode: input.mode ?? "export",
                sectionId: input.sectionId ?? null,
                entryId: entry.id,
              }),
            })}>
              ${
                input.sectionId
                  ? renderEntryHeading({
                      title: entry.title,
                      subtitle: entry.subtitle,
                      location: entry.location,
                      dateRange: entry.dateRange,
                      startDate: entry.startDate,
                      endDate: entry.endDate,
                      isCurrent: entry.isCurrent,
                      heading: entry.heading,
                      mode: input.mode ?? "export",
                      sectionId: input.sectionId,
                      entryId: entry.id,
                    })
                  : ""
              }
              ${
                entry.summary && input.sectionId
                  ? `<p${renderPreviewAttributes({
                      ...withPreviewSelection({
                        mode: input.mode ?? "export",
                        sectionId: input.sectionId,
                        entryId: entry.id,
                        targetId: getResumeEntryFieldTargetId(
                          input.sectionId,
                          entry.id,
                          "summary",
                        ),
                      }),
                    })}>${escapeHtml(entry.summary)}</p>`
                  : ""
              }
              ${
                entry.bullets.length > 0
                  ? `<ul class="resume-bullet-list">${entry.bullets
                      .map(
                        (bullet) =>
                          `<li${renderPreviewAttributes({
                            ...withPreviewSelection({
                              mode: input.mode ?? "export",
                              sectionId: input.sectionId ?? null,
                              entryId: entry.id,
                              targetId: input.sectionId
                                ? bullet.derivedFromSummary
                                  ? getResumeEntryFieldTargetId(
                                      input.sectionId,
                                      entry.id,
                                      "summary",
                                    )
                                  : getResumeEntryBulletTargetId(
                                      input.sectionId,
                                      entry.id,
                                      bullet.id,
                                    )
                                : null,
                            }),
                          })}>${escapeHtml(bullet.text)}</li>`,
                      )
                      .join("")}</ul>`
                  : ""
              }
            </article>
          `,
        )
        .join("")}
      ${
        bullets.length > 0
          ? `<ul class="resume-bullet-list">${bullets
              .map(
                (bullet) =>
                  `<li${renderPreviewAttributes({
                    ...withPreviewSelection({
                      mode: input.mode ?? "export",
                      sectionId: input.sectionId ?? null,
                      targetId: input.sectionId
                        ? getResumeSectionBulletTargetId(
                            input.sectionId,
                            bullet.id,
                          )
                        : null,
                    }),
                  })}>${escapeHtml(bullet.text)}</li>`,
              )
              .join("")}</ul>`
          : ""
      }
    </section>
  `;
}

function renderSection(
  section: RenderSection | null,
  className?: string,
  mode: ResumeRenderHtmlOptions["mode"] = "export",
): string {
  if (!section) {
    return "";
  }

  const payload = {
    sectionId: section.id,
    title: section.label,
    mode,
    text: section.text,
    bullets: section.bullets,
    entries: section.entries,
  } satisfies {
    sectionId: string;
    title: string;
    mode: "catalog" | "export" | "preview" | undefined;
    text: string | null;
    bullets: Array<{ id: string; text: string }>;
    entries: ReadonlyArray<{
      id: string;
      title: string | null;
      subtitle: string | null;
      location: string | null;
      dateRange: string | null;
      startDate?: string | null;
      endDate?: string | null;
      isCurrent?: boolean;
      heading: string | null;
      summary: string | null;
      bullets: Array<{ id: string; text: string }>;
    }>;
  };

  return renderStructuredSection(
    className
      ? {
          ...payload,
          className,
        }
      : payload,
  );
}

function renderInlineSection(input: {
  title: string;
  className?: string;
  mode?: "catalog" | "export" | "preview";
  groups: ReadonlyArray<{
    label?: string;
    values: ReadonlyArray<{ id: string; text: string }>;
    sectionId?: string | null;
  }>;
}): string {
  const groups = input.groups.filter((group) => group.values.length > 0);

  if (groups.length === 0) {
    return "";
  }

  return `
    <section class="section-block inline-section${input.className ? ` ${input.className}` : ""}">
      <h3>${escapeHtml(input.title)}</h3>
      <div class="inline-lines">
        ${groups
          .map(
            (group) =>
              `<p${renderPreviewAttributes({
                ...withPreviewSelection({
                  mode: input.mode ?? "export",
                  sectionId: group.sectionId ?? null,
                }),
              })}>${group.label ? `<strong>${escapeHtml(group.label)}:</strong> ` : ""}${group.values
                .map(
                  (value, index) =>
                    `<span${renderPreviewAttributes({
                      ...withPreviewSelection({
                        mode: input.mode ?? "export",
                        sectionId: group.sectionId ?? null,
                        targetId: group.sectionId
                          ? getResumeSectionBulletTargetId(
                              group.sectionId,
                              value.id,
                            )
                          : null,
                      }),
                    })}>${escapeHtml(value.text)}</span>${index < group.values.length - 1 ? ", " : ""}`,
                )
                .join("")}</p>`,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSkillMatrixSection(input: {
  title: string;
  className?: string;
  mode?: "catalog" | "export" | "preview";
  groups: ReadonlyArray<{
    label?: string;
    values: ReadonlyArray<{ id: string; text: string }>;
    sectionId?: string | null;
  }>;
}): string {
  const groups = input.groups.filter((group) => group.values.length > 0);

  if (groups.length === 0) {
    return "";
  }

  return `
    <section class="section-block skill-matrix${input.className ? ` ${input.className}` : ""}">
      <h3>${escapeHtml(input.title)}</h3>
      <div class="skill-groups">
        ${groups
          .map(
            (group) => `
              <div class="skill-group"${renderPreviewAttributes({
                ...withPreviewSelection({
                  mode: input.mode ?? "export",
                  sectionId: group.sectionId ?? null,
                }),
              })}>
                ${group.label ? `<p class="skill-group-label">${escapeHtml(group.label)}</p>` : ""}
                <ul class="skill-pill-list">${group.values
                  .map(
                    (value) =>
                      `<li${renderPreviewAttributes({
                        ...withPreviewSelection({
                          mode: input.mode ?? "export",
                          sectionId: group.sectionId ?? null,
                          targetId: group.sectionId
                            ? getResumeSectionBulletTargetId(
                                group.sectionId,
                                value.id,
                              )
                            : null,
                        }),
                      })}>${escapeHtml(value.text)}</li>`,
                  )
                  .join("")}</ul>
              </div>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderSummaryCallout(
  section: RenderSection | null,
  className?: string,
  mode: ResumeRenderHtmlOptions["mode"] = "export",
): string {
  if (!section) {
    return "";
  }

  return renderStructuredSection({
    sectionId: section.id,
    title: section.label,
    className: `section-summary-callout${className ? ` ${className}` : ""}`,
    mode,
    text: section.text,
    bullets: section.bullets,
    entries: section.entries,
  });
}

function renderSkillGroups(
  coreSkillsSection: RenderSection | null,
  additionalSkillsSection: RenderSection | null,
): Array<{
  label?: string;
  values: ReadonlyArray<{ id: string; text: string }>;
  sectionId?: string | null;
}> {
  return [
    {
      label: "Core",
      values: coreSkillsSection?.bullets ?? [],
      sectionId: coreSkillsSection?.id ?? null,
    },
    {
      label: "Additional",
      values: additionalSkillsSection?.bullets ?? [],
      sectionId: additionalSkillsSection?.id ?? null,
    },
  ];
}

interface SectionCatalog {
  summarySection: RenderSection | null;
  experienceSection: RenderSection | null;
  projectSection: RenderSection | null;
  educationSection: RenderSection | null;
  certificationSection: RenderSection | null;
  coreSkillsSection: RenderSection | null;
  additionalSkillsSection: RenderSection | null;
  languageSection: RenderSection | null;
  remainingSections: RenderSection[];
}

function buildSectionCatalog(
  renderDocument: ResumeRenderDocument,
): SectionCatalog {
  const summarySection =
    renderDocument.sections.find((section) => section.kind === "summary") ??
    null;
  const experienceSection =
    renderDocument.sections.find((section) => section.kind === "experience") ??
    null;
  const projectSection =
    renderDocument.sections.find((section) => section.kind === "projects") ??
    null;
  const educationSection =
    renderDocument.sections.find((section) => section.kind === "education") ??
    null;
  const certificationSection =
    renderDocument.sections.find(
      (section) => section.kind === "certifications",
    ) ?? null;
  const coreSkillsSection =
    renderDocument.sections.find(
      (section) => section.label === "Core Skills",
    ) ?? null;
  const additionalSkillsSection =
    renderDocument.sections.find(
      (section) => section.label === "Additional Skills",
    ) ?? null;
  const languageSection =
    renderDocument.sections.find((section) => section.label === "Languages") ??
    null;
  const knownSectionIds = new Set(
    [
      summarySection,
      experienceSection,
      projectSection,
      educationSection,
      certificationSection,
      coreSkillsSection,
      additionalSkillsSection,
      languageSection,
    ]
      .filter((section): section is RenderSection => section !== null)
      .map((section) => section.id),
  );

  return {
    summarySection,
    experienceSection,
    projectSection,
    educationSection,
    certificationSection,
    coreSkillsSection,
    additionalSkillsSection,
    languageSection,
    remainingSections: renderDocument.sections.filter(
      (section) =>
        section.kind !== "keywords" && !knownSectionIds.has(section.id),
    ),
  };
}

interface TemplateLayout {
  templateClassName: string;
  pageClassName: string;
  bodyClassName: string;
  headerMarkup: string;
  bodyContent: string;
}

type SkillGroup = {
  label?: string;
  values: ReadonlyArray<{ id: string; text: string }>;
  sectionId?: string | null;
};

interface TemplateRenderContext {
  renderDocument: ResumeRenderDocument;
  catalog: SectionCatalog;
  mode: RenderMode;
  skillGroups: SkillGroup[];
  remainingSectionContent: string[];
}

function joinRenderedSections(sections: readonly string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("");
}

function renderSectionCluster(
  className: string,
  sections: readonly string[],
): string {
  const content = joinRenderedSections(sections);

  if (!content) {
    return "";
  }

  return `<div class="${className}">${content}</div>`;
}

function renderIdentityMeta(
  values: ReadonlyArray<{ field: ResumePreviewIdentityField; text: string }>,
  className: string,
  mode: RenderMode,
  containerTag: "div" | "ul" = "div",
): string {
  if (values.length === 0) {
    return "";
  }

  if (containerTag === "ul") {
    return `<ul class="${className}">${values
      .map((value) =>
        renderIdentityFieldTag({
          mode,
          field: value.field,
          tagName: "li",
          text: value.text,
        }),
      )
      .join("")}</ul>`;
  }

  return `<div class="${className}">${values
    .map((value) =>
      renderIdentityFieldTag({
        mode,
        field: value.field,
        tagName: "span",
        text: value.text,
      }),
    )
    .join("")}</div>`;
}

function buildHeaderIdentityValues(
  renderDocument: ResumeRenderDocument,
): Array<{ field: ResumePreviewIdentityField; text: string }> {
  return [
    renderDocument.location
      ? {
          field: "location" as const,
          text: renderDocument.location,
        }
      : null,
    ...renderDocument.contactItems.map((item) => ({
      field: item.field,
      text: formatContactItem(item.text),
    })),
  ].filter(
    (value): value is { field: ResumePreviewIdentityField; text: string } =>
      Boolean(value),
  );
}

function renderClassicHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-classic">
      ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name", text: renderDocument.fullName })}
      ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline", text: renderDocument.headline }) : ""}
      ${renderIdentityMeta(contactValues, "meta", mode)}
    </header>`;
}

function renderSwissAccentHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-swiss-accent">
      <div class="identity-block">
        ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name name-left", text: renderDocument.fullName })}
        ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-left", text: renderDocument.headline }) : ""}
      </div>
      ${renderIdentityMeta(contactValues, "meta meta-left", mode)}
    </header>`;
}

function renderExecutiveHeader(
  renderDocument: ResumeRenderDocument,
  variant: "credentials" | "dense",
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-executive${variant === "credentials" ? " header-executive-credentials" : ""}">
      <div class="identity-block identity-block-tight">
        ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name", text: renderDocument.fullName })}
        ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-executive", text: renderDocument.headline }) : ""}
      </div>
      ${renderIdentityMeta(contactValues, "meta-pill-list", mode, "ul")}
    </header>`;
}

function renderEngineeringSpecHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-spec">
      <div class="header-spec-shell">
        <div class="identity-block">
          ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name name-left", text: renderDocument.fullName })}
          ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-left headline-spec", text: renderDocument.headline }) : ""}
        </div>
        ${renderIdentityMeta(contactValues, "meta-stack", mode)}
      </div>
    </header>`;
}

function renderPortfolioHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-portfolio">
      <div class="identity-block">
        ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name name-left", text: renderDocument.fullName })}
        ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-left headline-portfolio", text: renderDocument.headline }) : ""}
      </div>
      ${renderIdentityMeta(contactValues, "meta-pill-list meta-pill-list-left meta-pill-list-warm", mode, "ul")}
    </header>`;
}

function renderLongformHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-longform">
      <div class="header-longform-topline header-longform-topline-contact">
        ${renderIdentityMeta(contactValues, "meta meta-longform", mode)}
      </div>
      <div class="identity-block">
        ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name name-left name-longform", text: renderDocument.fullName })}
        ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-left headline-longform", text: renderDocument.headline }) : ""}
      </div>
    </header>`;
}

function renderCareerPivotHeader(
  renderDocument: ResumeRenderDocument,
  mode: RenderMode,
): string {
  const contactValues = buildHeaderIdentityValues(renderDocument);

  return `<header class="header header-pivot">
      <div class="identity-block identity-block-pivot">
        ${renderIdentityFieldTag({ mode, field: "fullName", tagName: "h1", className: "name name-left name-pivot", text: renderDocument.fullName })}
        ${renderDocument.headline ? renderIdentityFieldTag({ mode, field: "headline", tagName: "p", className: "headline headline-left headline-pivot", text: renderDocument.headline }) : ""}
      </div>
      ${renderIdentityMeta(contactValues, "meta-pill-list meta-pill-list-left meta-pill-list-pivot", mode, "ul")}
    </header>`;
}

function countSectionEntries(section: RenderSection | null): number {
  return section?.entries.length ?? 0;
}

function countSectionBullets(section: RenderSection | null): number {
  return section?.bullets.length ?? 0;
}

function renderCareerSnapshotSection(context: TemplateRenderContext): string {
  const formatSnapshotLabel = (
    singular: string,
    plural: string,
    value: number,
  ) => (value === 1 ? singular : plural);
  const snapshotValues = [
    {
      value: countSectionEntries(context.catalog.experienceSection),
      singularLabel: "Role",
      pluralLabel: "Roles",
    },
    {
      value: countSectionEntries(context.catalog.projectSection),
      singularLabel: "Project",
      pluralLabel: "Projects",
    },
    {
      value:
        countSectionBullets(context.catalog.coreSkillsSection) +
        countSectionBullets(context.catalog.additionalSkillsSection),
      singularLabel: "Skill signal",
      pluralLabel: "Skill signals",
    },
  ].filter((item) => item.value > 0);

  if (snapshotValues.length === 0) {
    return "";
  }

  return `
    <section class="section-block career-snapshot">
      <h3>Career Snapshot</h3>
      <ul class="snapshot-list">
        ${snapshotValues.map((item) => `<li><strong>${escapeHtml(String(item.value))}</strong><span>${escapeHtml(formatSnapshotLabel(item.singularLabel, item.pluralLabel, item.value))}</span></li>`).join("")}
      </ul>
    </section>
  `;
}

function renderTechnicalSkillsInlineSection(
  context: TemplateRenderContext,
  className?: string,
): string {
  return renderInlineSection({
    title: "Skills",
    mode: context.mode,
    groups: context.skillGroups,
    ...(className ? { className } : {}),
  });
}

function renderTechnicalSkillsMatrixSection(
  context: TemplateRenderContext,
  className?: string,
): string {
  return renderSkillMatrixSection({
    title: "Skills",
    mode: context.mode,
    groups: context.skillGroups,
    ...(className ? { className } : {}),
  });
}

function renderLanguagesSection(
  section: RenderSection | null,
  mode: RenderMode,
  className?: string,
): string {
  if (!section) {
    return "";
  }

  return renderInlineSection({
    title: "Languages",
    mode,
    groups: [{ values: section.bullets, sectionId: section.id }],
    ...(className ? { className } : {}),
  });
}

function createTemplateRenderContext(input: {
  renderDocument: ResumeRenderDocument;
  mode: RenderMode;
}): TemplateRenderContext {
  const catalog = buildSectionCatalog(input.renderDocument);

  return {
    renderDocument: input.renderDocument,
    catalog,
    mode: input.mode,
    skillGroups: renderSkillGroups(
      catalog.coreSkillsSection,
      catalog.additionalSkillsSection,
    ),
    remainingSectionContent: catalog.remainingSections.map((section) =>
      renderSection(section, undefined, input.mode),
    ),
  };
}

function buildSwissMinimalStandardLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-classic_ats",
    pageClassName: "page page-classic",
    bodyClassName: "body-grid body-grid-classic",
    headerMarkup: renderClassicHeader(context.renderDocument, context.mode),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-cluster-classic-intro", [
        renderSection(context.catalog.summarySection, undefined, context.mode),
        renderTechnicalSkillsInlineSection(context),
      ]),
      renderSection(context.catalog.experienceSection, undefined, context.mode),
      renderSection(context.catalog.projectSection, undefined, context.mode),
      renderSectionCluster("section-cluster section-cluster-classic-support", [
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card",
          context.mode,
        ),
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildSwissMinimalAccentLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-modern_split",
    pageClassName: "page page-modern",
    bodyClassName: "body-grid body-grid-modern",
    headerMarkup: renderSwissAccentHeader(context.renderDocument, context.mode),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-intro-band", [
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-summary-accent",
          context.mode,
        ),
        renderTechnicalSkillsMatrixSection(context, "section-surface-block"),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline",
        context.mode,
      ),
      renderSection(
        context.catalog.projectSection,
        "section-project-accent section-proof-led section-project-spotlight",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-cluster-supporting", [
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card",
          context.mode,
        ),
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildExecutiveBriefDenseLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-compact_exec",
    pageClassName: "page page-compact",
    bodyClassName: "body-grid body-grid-compact",
    headerMarkup: renderExecutiveHeader(
      context.renderDocument,
      "dense",
      context.mode,
    ),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-executive-intro", [
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-summary-tight section-summary-elevated",
          context.mode,
        ),
        renderTechnicalSkillsInlineSection(
          context,
          "section-executive-rundown",
        ),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline section-dense-chronology",
        context.mode,
      ),
      renderSection(
        context.catalog.projectSection,
        "section-proof-led section-proof-compact",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-cluster-compact-support", [
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card section-subtle-card-tight",
          context.mode,
        ),
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card section-subtle-card-tight",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildExecutiveBriefCredentialsLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-credentials_focus",
    pageClassName: "page page-credentials",
    bodyClassName: "body-grid body-grid-credentials",
    headerMarkup: renderExecutiveHeader(
      context.renderDocument,
      "credentials",
      context.mode,
    ),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-credential-spotlight", [
        renderSection(
          context.catalog.certificationSection,
          "section-credential-grid section-credential-spotlight-surface",
          context.mode,
        ),
        renderSection(
          context.catalog.educationSection,
          "section-credential-grid section-credential-spotlight-surface",
          context.mode,
        ),
      ]),
      renderSectionCluster("section-cluster section-executive-intro", [
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-summary-tight section-summary-elevated",
          context.mode,
        ),
        renderTechnicalSkillsInlineSection(
          context,
          "section-executive-rundown",
        ),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline",
        context.mode,
      ),
      renderSection(
        context.catalog.projectSection,
        "section-proof-led",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-cluster-supporting", [
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildEngineeringSpecLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-technical_matrix",
    pageClassName: "page page-technical",
    bodyClassName: "body-grid body-grid-technical",
    headerMarkup: renderEngineeringSpecHeader(
      context.renderDocument,
      context.mode,
    ),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-spec-lead", [
        renderTechnicalSkillsMatrixSection(
          context,
          "section-technical-matrix section-spec-shell",
        ),
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-summary-tight section-spec-shell",
          context.mode,
        ),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline section-spec-chronology",
        context.mode,
      ),
      renderSection(
        context.catalog.projectSection,
        "section-proof-led section-spec-projects",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-spec-supporting", [
        renderSection(
          context.catalog.certificationSection,
          "section-credential-grid section-spec-shell",
          context.mode,
        ),
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card section-spec-shell",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildPortfolioNarrativeLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-project_showcase",
    pageClassName: "page page-projects",
    bodyClassName: "body-grid body-grid-projects",
    headerMarkup: renderPortfolioHeader(context.renderDocument, context.mode),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-portfolio-hero", [
        renderSection(
          context.catalog.projectSection,
          "section-project-accent section-proof-led section-project-spotlight section-portfolio-highlight",
          context.mode,
        ),
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-portfolio-narrative",
          context.mode,
        ),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline section-portfolio-chronology",
        context.mode,
      ),
      renderTechnicalSkillsMatrixSection(
        context,
        "section-surface-block section-portfolio-skills",
      ),
      renderSectionCluster("section-cluster section-portfolio-supporting", [
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card",
          context.mode,
        ),
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildLongformTimelineLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-timeline_longform",
    pageClassName: "page page-longform",
    bodyClassName: "body-grid body-grid-longform",
    headerMarkup: renderLongformHeader(context.renderDocument, context.mode),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-longform-orientation", [
        renderCareerSnapshotSection(context),
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-summary-tight section-longform-summary",
          context.mode,
        ),
        renderTechnicalSkillsInlineSection(context, "section-longform-skills"),
      ]),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline section-longform-chronology",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-longform-proof", [
        renderSection(
          context.catalog.projectSection,
          "section-proof-led section-proof-compact",
          context.mode,
        ),
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card section-subtle-card-tight",
          context.mode,
        ),
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card section-subtle-card-tight",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildCareerPivotLayout(
  context: TemplateRenderContext,
): TemplateLayout {
  return {
    templateClassName: "theme-career_pivot",
    pageClassName: "page page-pivot",
    bodyClassName: "body-grid body-grid-pivot",
    headerMarkup: renderCareerPivotHeader(context.renderDocument, context.mode),
    bodyContent: joinRenderedSections([
      renderSectionCluster("section-cluster section-pivot-bridge", [
        renderSummaryCallout(
          context.catalog.summarySection,
          "section-pivot-summary",
          context.mode,
        ),
        renderTechnicalSkillsMatrixSection(
          context,
          "section-surface-block section-pivot-skills",
        ),
      ]),
      renderSection(
        context.catalog.projectSection,
        "section-project-accent section-proof-led section-pivot-proof",
        context.mode,
      ),
      renderSection(
        context.catalog.experienceSection,
        "section-timeline section-pivot-chronology",
        context.mode,
      ),
      renderSectionCluster("section-cluster section-pivot-supporting", [
        renderSection(
          context.catalog.certificationSection,
          "section-subtle-card",
          context.mode,
        ),
        renderSection(
          context.catalog.educationSection,
          "section-subtle-card",
          context.mode,
        ),
        ...context.remainingSectionContent,
        renderLanguagesSection(context.catalog.languageSection, context.mode),
      ]),
    ]),
  };
}

function buildTemplateLayout(input: {
  renderDocument: ResumeRenderDocument;
  templateId: ResumeTemplateId;
  mode?: "catalog" | "export" | "preview";
}): TemplateLayout {
  const context = createTemplateRenderContext({
    renderDocument: input.renderDocument,
    mode: input.mode ?? "export",
  });

  switch (input.templateId) {
    case "compact_exec":
      return buildExecutiveBriefDenseLayout(context);
    case "modern_split":
      return buildSwissMinimalAccentLayout(context);
    case "technical_matrix":
      return buildEngineeringSpecLayout(context);
    case "project_showcase":
      return buildPortfolioNarrativeLayout(context);
    case "credentials_focus":
      return buildExecutiveBriefCredentialsLayout(context);
    case "timeline_longform":
      return buildLongformTimelineLayout(context);
    case "career_pivot":
      return buildCareerPivotLayout(context);
    case "classic_ats":
    default:
      return buildSwissMinimalStandardLayout(context);
  }
}

export function renderResumeTemplateHtml(
  input: {
    renderDocument: ResumeRenderDocument;
    settings: JobFinderSettings;
    templateId: ResumeTemplateId;
  },
  options?: ResumeRenderHtmlOptions,
): string {
  const mode = options?.mode ?? "export";
  const catalogLayout = options?.catalogLayout ?? "thumbnail";
  const fontFamily = formatFontFamily(input.settings.fontPreset);
  const layout = buildTemplateLayout({
    ...input,
    mode,
  });
  const templateDefinition = getLocalResumeTemplateDefinition(input.templateId);
  const sharedStyles = `
    @page {
      size: Letter;
      margin: 0;
    }
    /* Physical page margins repeat on continuation pages; article padding does not. */
    @page resume-classic { margin: 0.52in 0.62in; }
    @page resume-compact { margin: 0.44in 0.54in; }
    @page resume-modern { margin: 0.54in 0.64in; }
    @page resume-technical { margin: 0.48in 0.58in; }
    @page resume-projects { margin: 0.56in 0.66in; }
    @page resume-credentials { margin: 0.52in 0.64in; }
    @page resume-longform { margin: 0.4in 0.52in; }
    @page resume-pivot { margin: 0.52in 0.64in; }
    :root {
      color-scheme: light;
      --resume-font-family: var(--font-body, ${fontFamily});
      /* The page is paper, never an app surface: the preview must show the
         same white the export prints, so a reviewer never judges their
         resume through a tinted or dark app panel. The pane behind the
         page stays tinted through --resume-preview-canvas. */
      --resume-paper: #ffffff;
      --resume-preview-canvas: var(--surface-muted, #e7edf6);
      --resume-catalog-canvas-start: var(--surface-raised, rgba(241, 245, 249, 0.98));
      --resume-catalog-canvas-end: var(--surface-muted, rgba(226, 232, 240, 0.94));
      --resume-catalog-thumbnail-start: var(--surface-raised, rgba(241, 245, 249, 0.92));
      --resume-catalog-thumbnail-end: var(--card, rgba(255, 255, 255, 0.98));
      --resume-shadow-color: rgba(24, 38, 62, 0.18);
      /* Linked-entry affordances outline the target instead of tinting it:
         a fill read as a permanent grey highlight band on the page. */
      --resume-selected-shadow: rgba(31, 58, 95, 0.55);
      --resume-selected-surface: transparent;
      --resume-hover-shadow: rgba(31, 58, 95, 0.3);
      --resume-hover-surface: transparent;
      --resume-page-padding-classic: 0.52in 0.62in;
      --resume-page-padding-compact: 0.44in 0.54in;
      --resume-page-padding-modern: 0.54in 0.64in;
      --resume-page-padding-technical: 0.48in 0.58in;
      --resume-page-padding-projects: 0.56in 0.66in;
      --resume-page-padding-credentials: 0.52in 0.64in;
      --resume-page-padding-longform: 0.4in 0.52in;
      --resume-page-padding-pivot: 0.52in 0.64in;
      --resume-catalog-page-padding-classic: 0.42in 0.48in;
      --resume-catalog-page-padding-compact: 0.38in 0.42in;
      --resume-catalog-page-padding-modern: 0.42in 0.48in;
      --resume-catalog-page-padding-technical: 0.4in 0.44in;
      --resume-catalog-page-padding-projects: 0.44in 0.5in;
      --resume-catalog-page-padding-credentials: 0.42in 0.48in;
      --resume-catalog-page-padding-longform: 0.34in 0.4in;
      --resume-catalog-page-padding-pivot: 0.42in 0.48in;
      --resume-classic-accent: #1f2933;
      --resume-classic-line: #c7cdd3;
      --resume-classic-surface: #f6f7f8;
      --resume-compact-accent: #182433;
      --resume-compact-line: #aeb8c2;
      --resume-compact-surface: #f4f6f7;
      --resume-modern-accent: #145c63;
      --resume-modern-line: #b7c9ca;
      --resume-modern-surface: #f2f7f7;
      --resume-technical-accent: #234d72;
      --resume-technical-line: #b7c3ce;
      --resume-technical-surface: #f3f6f8;
      --resume-projects-accent: #6a3e55;
      --resume-projects-line: #cabcc3;
      --resume-projects-surface: #f8f4f6;
      --resume-credentials-accent: #4a3f2c;
      --resume-credentials-line: #c8c0b2;
      --resume-credentials-surface: #f8f6f1;
      --resume-longform-accent: #30343a;
      --resume-longform-line: #b9bdc2;
      --resume-longform-surface: #f5f5f4;
      --resume-pivot-accent: #365947;
      --resume-pivot-line: #bcc8c1;
      --resume-pivot-surface: #f3f7f4;
      /* Document ink stays paper ink. Binding it to the app foreground made
         the preview readable only while the app happened to be light. */
      --ink: #202124;
      --muted: #4f5661;
      --line: var(--resume-classic-line);
      --accent: var(--resume-classic-accent);
      --surface: var(--resume-classic-surface);
      font-family: var(--resume-font-family);
    }
    * { box-sizing: border-box; }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; background: var(--resume-paper); color: var(--ink); font-family: var(--resume-font-family); }
    .page { width: 8.5in; min-height: 11in; margin: 0 auto; background: var(--resume-paper); overflow-wrap: anywhere; }
    .page * { min-width: 0; }
    .page-classic { padding: var(--resume-page-padding-classic); }
    .page-compact { padding: var(--resume-page-padding-compact); }
    .page-modern { padding: var(--resume-page-padding-modern); }
    .page-technical { padding: var(--resume-page-padding-technical); }
    .page-projects { padding: var(--resume-page-padding-projects); }
    .page-credentials { padding: var(--resume-page-padding-credentials); }
    .page-longform { padding: var(--resume-page-padding-longform); }
    .page-pivot { padding: var(--resume-page-padding-pivot); }
    h1, h2, h3, h4, p, ul { margin: 0; }
    .name { font-size: 1.72rem; line-height: 1.04; letter-spacing: -0.025em; text-align: center; font-weight: 720; }
    .name-left { text-align: left; }
    .headline { font-size: 0.94rem; line-height: 1.3; color: var(--muted); text-align: center; }
    .headline-left { text-align: left; }
    .identity-block { display: grid; gap: 0.12rem; }
    .identity-block-tight { gap: 0.08rem; }
    h3 { font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.075em; color: var(--accent); border-bottom: 1px solid var(--line); padding-bottom: 0.11rem; margin-bottom: 0.3rem; break-after: avoid; page-break-after: avoid; }
    h4 { display: grid; grid-template-columns: minmax(0, 1fr) max-content; align-items: baseline; gap: 0.12rem 0.8rem; font-size: 0.91rem; line-height: 1.28; font-weight: 720; break-after: avoid; page-break-after: avoid; }
    p, li { font-size: 0.875rem; line-height: 1.4; }
    ul { padding-left: 1.08rem; display: grid; gap: 0.12rem; }
    li { padding-left: 0.03rem; }
    .resume-bullet-list { list-style: none; padding-left: 0.62rem; }
    .resume-bullet-list li { display: grid; grid-template-columns: 0.42rem 1fr; column-gap: 0.18rem; padding-left: 0; }
    .resume-bullet-list li::before { content: '•'; color: var(--ink); }
    .header { display: grid; gap: 0.16rem; padding-bottom: 0.38rem; border-bottom: 1px solid var(--line); }
    .header-classic { justify-items: center; text-align: center; }
    .header-swiss-accent { justify-items: start; text-align: left; border-top: 0.06in solid var(--accent); border-bottom: 1px solid var(--line); padding-top: 0.2rem; gap: 0.2rem; }
    .header-executive { justify-items: center; text-align: center; border-top: 2px solid var(--accent); border-bottom: 1px solid var(--accent); padding-top: 0.2rem; gap: 0.16rem; }
    .header-executive-credentials { padding: 0.18in 0 0.16in; border-top: 3px double var(--accent); border-bottom: 1px solid var(--accent); }
    .header-spec { border-bottom: 2px solid var(--accent); padding-bottom: 0.34rem; }
    .header-spec-shell { display: grid; gap: 0.16rem; border-left: 0.045in solid var(--accent); padding: 0.03in 0 0.03in 0.16in; }
    .header-portfolio { justify-items: start; text-align: left; border-bottom: 1px solid var(--line); gap: 0.2rem; }
    .header-longform { gap: 0.16rem; border-bottom: 3px double var(--line); padding-bottom: 0.28rem; }
    .header-longform-topline { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.12rem 0.45rem; }
    .header-longform-topline-contact { justify-content: flex-end; }
    .header-pivot { justify-items: start; text-align: left; gap: 0.17rem; border-top: 0.055in solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.16in 0 0.14in; }
    .meta { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.18rem 0.55rem; color: var(--muted); font-size: 0.82rem; }
    .meta-left { justify-content: flex-start; }
    .meta-longform { justify-content: flex-end; font-size: 0.75rem; gap: 0.12rem 0.4rem; }
    .meta-stack { display: grid; gap: 0.08rem; color: var(--muted); font-size: 0.8rem; }
    .meta-pill-list { list-style: none; padding-left: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 0.12rem 0.5rem; color: var(--muted); }
    .meta-pill-list li { padding: 0; font-size: 0.76rem; line-height: 1.2; }
    .meta-pill-list li + li::before { content: '|'; color: var(--line); margin-right: 0.5rem; }
    .meta-pill-list-left { justify-content: flex-start; }
    .meta-pill-list-warm li,
    .meta-pill-list-pivot li { background: transparent; }
    .section-block { display: grid; gap: 0.24rem; }
    .section-cluster { display: grid; gap: 0.42rem; }
    .section-cluster-classic-intro,
    .section-intro-band,
    .section-executive-intro,
    .section-spec-lead,
    .section-portfolio-hero,
    .section-credential-spotlight,
    .section-longform-orientation,
    .section-pivot-bridge { padding-bottom: 0.08rem; border-bottom: 1px solid color-mix(in srgb, var(--line) 72%, var(--resume-paper)); }
    .section-cluster-classic-support,
    .section-cluster-supporting,
    .section-cluster-compact-support,
    .section-spec-supporting,
    .section-portfolio-supporting,
    .section-longform-proof,
    .section-pivot-supporting { gap: 0.34rem; }
    .section-summary-callout { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 0.14in 0; }
    .section-summary-tight { padding: 0.1in 0; }
    .section-summary-accent { border-top: 0; border-bottom: 0; border-left: 0.045in solid var(--accent); padding: 0.04in 0 0.04in 0.16in; }
    .section-summary-elevated { border-top-color: var(--accent); border-bottom-color: var(--line); }
    .section-subtle-card { border-top: 1px solid var(--line); padding-top: 0.12in; }
    .section-subtle-card-tight { padding-top: 0.08in; }
    .section-surface-block { border-top: 1px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.12in 0; }
    .section-executive-rundown .inline-lines { gap: 0.12rem; }
    .section-executive-rundown .inline-lines p { border-bottom: 1px solid color-mix(in srgb, var(--line) 72%, var(--resume-paper)); padding-bottom: 0.08rem; }
    .section-project-accent .entry-block { border-left: 2px solid var(--accent); padding-left: 0.16rem; }
    .section-credential-grid .entry-block { border-top: 1px solid var(--line); padding-top: 0.12in; }
    .section-credential-spotlight-surface { border-top: 2px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.14in 0 0.12in; }
    .section-timeline .entry-block { border-left: 1px solid color-mix(in srgb, var(--accent) 32%, var(--resume-paper)); padding-left: 0.18rem; }
    .section-dense-chronology .entry-block { margin-top: 0.18rem; }
    .section-proof-led .entry-block { border-top: 1px solid color-mix(in srgb, var(--line) 74%, var(--resume-paper)); padding-top: 0.18rem; }
    .section-proof-compact .entry-block { gap: 0.12rem; }
    .section-project-spotlight { border-top: 2px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.16in 0; }
    .section-portfolio-highlight { background: transparent; }
    .section-portfolio-narrative { border-top: 0; border-bottom: 1px solid var(--line); padding-top: 0; }
    .section-spec-shell { background: transparent; }
    .section-technical-matrix.section-spec-shell { border-top: 1px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.12in 0; }
    .section-longform-summary { border-left: 0.08in solid color-mix(in srgb, var(--accent) 28%, var(--resume-paper)); }
    .section-longform-skills .inline-lines { gap: 0.06rem; }
    .section-longform-skills .inline-lines p { font-size: 0.79rem; line-height: 1.24; }
    .section-longform-chronology .entry-block { border-left: 0; border-top: 1px solid color-mix(in srgb, var(--line) 70%, var(--resume-paper)); padding-top: 0.13rem; padding-left: 0; margin-top: 0.16rem; }
    .section-pivot-summary { border-top: 0; border-bottom: 0; border-left: 0.05in solid var(--accent); padding: 0.04in 0 0.04in 0.16in; }
    .section-pivot-proof { border-top: 2px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.16in 0; }
    .section-pivot-proof .entry-block:first-of-type { margin-top: 0; }
    .section-pivot-chronology .entry-block { border-left-style: solid; }
    .career-snapshot { border-top: 2px solid var(--accent); border-bottom: 1px solid var(--line); padding: 0.1in 0; }
    .snapshot-list { list-style: none; padding-left: 0; display: grid; grid-template-columns: 1fr; gap: 0.08rem; }
    .snapshot-list li { display: grid; grid-template-columns: 1.8rem 1fr; align-items: baseline; gap: 0.1rem; border-bottom: 1px solid color-mix(in srgb, var(--line) 70%, var(--resume-paper)); padding: 0 0 0.06rem; font-size: 0.72rem; line-height: 1.14; }
    .snapshot-list strong { color: var(--accent); font-size: 0.95rem; line-height: 1; }
    .snapshot-list span { color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .entry-block { display: grid; gap: 0.18rem; margin-top: 0.24rem; break-inside: avoid; page-break-inside: avoid; }
    .entry-primary { min-width: 0; }
    .entry-meta { color: var(--muted); font-size: 0.84rem; font-weight: 500; justify-self: end; white-space: nowrap; }
    .inline-lines { display: grid; gap: 0.1rem; }
    .inline-lines p { line-height: 1.32; }
    .inline-lines strong { color: var(--ink); font-weight: 700; }
    .skill-matrix { gap: 0.32rem; }
    .skill-groups { display: grid; gap: 0.26rem; }
    .skill-group { display: grid; gap: 0.12rem; }
    .skill-group-label { font-size: 0.72rem; line-height: 1.1; color: var(--muted); font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .skill-pill-list { list-style: none; padding-left: 0; display: flex; flex-wrap: wrap; gap: 0.08rem 0.34rem; }
    .skill-pill-list li { padding: 0; font-size: 0.81rem; line-height: 1.25; }
    .skill-pill-list li + li::before { content: '·'; color: var(--accent); margin-right: 0.34rem; }
    .body-grid { display: grid; grid-template-columns: 1fr; }
    .body-grid-classic { gap: 0.62rem; margin-top: 0.68rem; }
    .body-grid-compact { gap: 0.5rem; margin-top: 0.58rem; }
    .body-grid-modern { gap: 0.58rem; margin-top: 0.64rem; }
    .body-grid-technical { gap: 0.54rem; margin-top: 0.62rem; }
    .body-grid-projects { gap: 0.64rem; margin-top: 0.68rem; }
    .body-grid-credentials { gap: 0.58rem; margin-top: 0.64rem; }
    .body-grid-longform { gap: 0.42rem; margin-top: 0.48rem; }
    .body-grid-pivot { gap: 0.58rem; margin-top: 0.64rem; }
    .theme-classic_ats { --accent: var(--resume-classic-accent); --line: var(--resume-classic-line); --surface: var(--resume-classic-surface); }
    .theme-compact_exec { --accent: var(--resume-compact-accent); --line: var(--resume-compact-line); --surface: var(--resume-compact-surface); }
    .theme-modern_split { --accent: var(--resume-modern-accent); --line: var(--resume-modern-line); --surface: var(--resume-modern-surface); }
    .theme-technical_matrix { --accent: var(--resume-technical-accent); --line: var(--resume-technical-line); --surface: var(--resume-technical-surface); }
    .theme-project_showcase { --accent: var(--resume-projects-accent); --line: var(--resume-projects-line); --surface: var(--resume-projects-surface); }
    .theme-credentials_focus { --accent: var(--resume-credentials-accent); --line: var(--resume-credentials-line); --surface: var(--resume-credentials-surface); }
    .theme-timeline_longform { --accent: var(--resume-longform-accent); --line: var(--resume-longform-line); --surface: var(--resume-longform-surface); }
    .theme-career_pivot { --accent: var(--resume-pivot-accent); --line: var(--resume-pivot-line); --surface: var(--resume-pivot-surface); }
    .theme-classic_ats .name { font-family: Georgia, 'Times New Roman', serif; font-size: 1.82rem; font-weight: 600; letter-spacing: -0.01em; }
    .theme-classic_ats h3 { color: var(--ink); letter-spacing: 0.06em; }
    .theme-classic_ats .header { border-top: 1px solid var(--ink); padding-top: 0.16rem; border-bottom-color: var(--ink); }
    .theme-compact_exec .name { letter-spacing: -0.035em; }
    .theme-compact_exec h3 { border-bottom: 0; border-left: 0.035in solid var(--accent); padding: 0 0 0 0.12rem; letter-spacing: 0.09em; }
    .theme-compact_exec .section-cluster { gap: 0.3rem; }
    .theme-modern_split .name { font-size: 1.92rem; letter-spacing: -0.04em; }
    .theme-modern_split h3 { border-bottom: 0; border-left: 0.04in solid var(--accent); padding: 0 0 0 0.14rem; letter-spacing: 0.1em; }
    .theme-technical_matrix .name { font-size: 1.62rem; letter-spacing: -0.015em; }
    .theme-technical_matrix h3 { color: var(--accent); border-bottom: 2px solid var(--accent); font-size: 0.72rem; letter-spacing: 0.11em; }
    .theme-technical_matrix .skill-pill-list li { font-size: 0.79rem; }
    .theme-technical_matrix .skill-group { border-top: 1px solid var(--line); padding-top: 0.12rem; }
    .theme-project_showcase .name { font-size: 1.96rem; letter-spacing: -0.04em; }
    .theme-project_showcase h3 { border-top: 1px solid var(--accent); border-bottom: 0; padding-top: 0.1rem; padding-bottom: 0; letter-spacing: 0.11em; }
    .theme-project_showcase .section-project-spotlight .entry-block:first-of-type { margin-top: 0; }
    .theme-credentials_focus .name { font-family: Georgia, 'Times New Roman', serif; font-size: 1.8rem; font-weight: 600; letter-spacing: -0.01em; }
    .theme-credentials_focus h3 { font-family: Georgia, 'Times New Roman', serif; color: var(--accent); font-size: 0.82rem; letter-spacing: 0.045em; text-transform: none; border-bottom-color: var(--accent); }
    .theme-timeline_longform h3 { color: var(--ink); border-bottom: 0; border-top: 1px solid var(--ink); padding: 0.1rem 0 0; letter-spacing: 0.07em; }
    .theme-career_pivot .name { font-size: 1.84rem; }
    .theme-career_pivot h3 { color: var(--accent); border-bottom: 0; border-left: 0.045in solid var(--accent); padding: 0 0 0 0.14rem; letter-spacing: 0.08em; }
    .page-compact .name { font-size: 1.54rem; }
    .page-compact .headline { font-size: 0.9rem; }
    .page-compact p, .page-compact li { font-size: 0.84rem; line-height: 1.3; }
    .page-compact h3 { font-size: 0.76rem; }
    .page-compact .header { gap: 0.14rem; padding-bottom: 0.34rem; }
    .page-technical p, .page-technical li { font-size: 0.86rem; }
    .page-projects .section-project-accent .entry-block { padding-left: 0.2rem; }
    .page-longform .name { font-size: 1.48rem; }
    .page-longform .headline { font-size: 0.86rem; }
    .page-longform h3 { font-size: 0.74rem; margin-bottom: 0.18rem; }
    .page-longform h4 { font-size: 0.84rem; line-height: 1.24; }
    .page-longform p, .page-longform li { font-size: 0.8rem; line-height: 1.25; }
    .page-longform .entry-block { gap: 0.11rem; }
    .page-pivot .name { font-size: 1.78rem; }
    .page-pivot .section-project-accent .entry-block { padding-left: 0.18rem; }
    @media print {
      html, body { width: auto; min-height: 0; background: #ffffff; }
      body { margin: 0; }
      .page { width: auto; min-height: 0; padding: 0; margin: 0; box-shadow: none !important; }
      .page-classic { page: resume-classic; }
      .page-compact { page: resume-compact; }
      .page-modern { page: resume-modern; }
      .page-technical { page: resume-technical; }
      .page-projects { page: resume-projects; }
      .page-credentials { page: resume-credentials; }
      .page-longform { page: resume-longform; }
      .page-pivot { page: resume-pivot; }
      .header, .entry-block, h3, h4, .skill-group { break-inside: avoid; page-break-inside: avoid; }
      a { color: inherit; text-decoration: none; }
      /* Chromium prints a grid container as one unbreakable box. With the
         body and every section laid out as grids, a resume a few pixels
         taller than a page moved its entire body to page two and left page
         one holding only the header. In print the body and sections flow as
         blocks with margin gaps instead, so pages break between entries. */
      .body-grid, .section-block, .section-cluster { display: block; }
      .body-grid > * + * { margin-top: var(--print-body-gap, 0.6rem); }
      .section-block > * + * { margin-top: 0.24rem; }
      .section-cluster > * + * { margin-top: 0.42rem; }
      .body-grid-classic { --print-body-gap: 0.62rem; }
      .body-grid-compact { --print-body-gap: 0.5rem; }
      .body-grid-modern { --print-body-gap: 0.58rem; }
      .body-grid-technical { --print-body-gap: 0.54rem; }
      .body-grid-projects { --print-body-gap: 0.64rem; }
      .body-grid-credentials { --print-body-gap: 0.58rem; }
      .body-grid-longform { --print-body-gap: 0.42rem; }
      .body-grid-pivot { --print-body-gap: 0.58rem; }
    }
    ${
      mode === "preview"
        ? `
    html, body.preview-body {
      height: 100%;
    }
    body.preview-body {
      --preview-scale: 1;
      background: var(--resume-preview-canvas);
      min-height: 100%;
      padding: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .preview-shell {
      width: fit-content;
      margin: 0 auto;
      padding: 0.375rem;
      display: grid;
      justify-items: start;
      align-content: start;
      zoom: var(--preview-scale);
    }
    .preview-body .page {
      min-height: auto;
      background: var(--resume-paper);
      box-shadow: 0 1px 2px var(--resume-shadow-color), 0 18px 44px var(--resume-shadow-color);
      margin: 0;
    }
    [data-resume-section-id], [data-resume-entry-id], [data-resume-target-id] { cursor: pointer; transition: box-shadow 120ms ease, background-color 120ms ease; border-radius: 0.02in; }
    [data-resume-entry-id] { padding: 0.035in 0.05in; margin-inline: -0.05in; }
    [data-resume-section-id][data-resume-selected="true"], [data-resume-entry-id][data-resume-selected="true"], [data-resume-target-id][data-resume-selected="true"] { box-shadow: 0 0 0 1px var(--resume-selected-shadow); background: var(--resume-selected-surface); }
    /* An accepted assistant proposal used to change the document silently.
       The lines it landed on stay marked until the edit is undone or the
       thread moves on, so the change is visible where it happened. */
    [data-resume-ai-edited="true"] { box-shadow: inset 3px 0 0 var(--resume-selected-shadow); background: var(--resume-hover-surface); }
    [data-resume-section-id]:hover, [data-resume-entry-id]:hover, [data-resume-target-id]:hover, [data-resume-section-id]:focus-visible, [data-resume-entry-id]:focus-visible, [data-resume-target-id]:focus-visible { box-shadow: 0 0 0 1px var(--resume-hover-shadow); background: var(--resume-hover-surface); outline: none; }
      `
        : ""
    }
    ${
      mode === "catalog"
        ? `
    body.catalog-body { margin: 0; overflow: hidden; }
    body.catalog-body.catalog-body-thumbnail { background: transparent; }
    .catalog-shell { overflow: hidden; }
    .catalog-shell-thumbnail { width: 188px; height: 243px; border-radius: 18px; background: linear-gradient(180deg, var(--resume-catalog-thumbnail-start), var(--resume-catalog-thumbnail-end)); }
    .catalog-shell-thumbnail .page { margin: 0; box-shadow: none; transform: scale(0.23); transform-origin: top left; }
    html:has(body.catalog-body.catalog-body-panel), body.catalog-body.catalog-body-panel { height: 100%; }
    body.catalog-body.catalog-body-panel {
      display: grid;
      align-items: start;
      background: linear-gradient(180deg, var(--resume-catalog-canvas-start), var(--resume-catalog-canvas-end));
      padding: 0;
      overflow: hidden;
    }
    .catalog-shell-panel {
      --catalog-scale: min(1, calc((100vw - 0.45rem) / 8.5in));
      width: fit-content;
      min-height: 100%;
      margin: 0 auto;
      padding: 0.14rem 0;
      display: grid;
      justify-items: start;
      align-content: start;
      zoom: var(--catalog-scale);
    }
    .catalog-shell-panel .page {
      margin: 0;
      /* A whole letter page, so the preview box can hold a fixed page
         ratio instead of measuring the sample and resizing after paint. */
      min-height: 11in;
      box-shadow: 0 20px 60px var(--resume-shadow-color);
    }
    .catalog-body-panel .page-classic { padding: var(--resume-catalog-page-padding-classic); }
    .catalog-body-panel .page-compact { padding: var(--resume-catalog-page-padding-compact); }
    .catalog-body-panel .page-modern { padding: var(--resume-catalog-page-padding-modern); }
    .catalog-body-panel .page-technical { padding: var(--resume-catalog-page-padding-technical); }
    .catalog-body-panel .page-projects { padding: var(--resume-catalog-page-padding-projects); }
    .catalog-body-panel .page-credentials { padding: var(--resume-catalog-page-padding-credentials); }
    .catalog-body-panel .page-longform { padding: var(--resume-catalog-page-padding-longform); }
    .catalog-body-panel .page-pivot { padding: var(--resume-catalog-page-padding-pivot); }
    .catalog-body-panel .header { gap: 0.12rem; padding-bottom: 0.3rem; }
    .catalog-body-panel .body-grid-classic,
    .catalog-body-panel .body-grid-compact,
    .catalog-body-panel .body-grid-modern,
    .catalog-body-panel .body-grid-technical,
    .catalog-body-panel .body-grid-projects,
    .catalog-body-panel .body-grid-credentials,
    .catalog-body-panel .body-grid-longform,
    .catalog-body-panel .body-grid-pivot { gap: 0.44rem; margin-top: 0.48rem; }
    .catalog-body-panel .section-cluster { gap: 0.28rem; }
    .catalog-body-panel .section-summary-callout,
    .catalog-body-panel .section-subtle-card,
    .catalog-body-panel .section-surface-block,
    .catalog-body-panel .section-project-spotlight,
    .catalog-body-panel .section-credential-spotlight-surface { padding: 0.11in 0.12in; }
    .catalog-body-panel .entry-block { gap: 0.12rem; margin-top: 0.16rem; }
    .catalog-body-panel .skill-groups { gap: 0.18rem; }
    .catalog-body-panel .skill-pill-list { gap: 0.12rem; }
    .catalog-body-panel .skill-pill-list li,
    .catalog-body-panel .meta-pill-list li { padding: 0.06rem 0.3rem; }
    .catalog-body-panel h3 { margin-bottom: 0.18rem; }
    .catalog-body-panel p,
    .catalog-body-panel li { line-height: 1.28; }
      `
        : ""
    }
  `;

  const articleMarkup = `<article class="${layout.pageClassName} ${layout.templateClassName}" data-ats-safe="true">
      ${layout.headerMarkup}
      <div class="${layout.bodyClassName}">
        ${layout.bodyContent}
      </div>
    </article>`;

  const bodyClassName = [
    mode === "preview" ? "preview-body" : null,
    mode === "catalog" ? "catalog-body" : null,
    mode === "catalog" ? `catalog-body-${catalogLayout}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const catalogShellClassName = `catalog-shell catalog-shell-${catalogLayout}`;

  // The studio preview and the template catalog render this document inside a
  // srcdoc iframe. The renderer emits no script of its own, and this policy
  // makes that a guarantee the browser enforces: nothing in a resume - not
  // imported text, not a model rewrite - can execute in the frame, and the
  // frame loads no network resource. Blocking script here (rather than with a
  // `sandbox` attribute that has to keep `allow-same-origin` for the studio's
  // click-to-edit binding) also keeps the renderer console free of Chromium's
  // "Blocked script execution in 'about:srcdoc'" notice, which the host
  // emitted on every preview reload. The exported/print document is unchanged.
  const framedDocumentPolicy =
    mode === "preview" || mode === "catalog"
      ? `\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:;" />`
      : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />${framedDocumentPolicy}
    <title>${escapeHtml(input.renderDocument.fullName)} Resume</title>
    <meta name="resume-template" content="${escapeHtml(templateDefinition.label)}" />
    <style>
      ${sharedStyles}
    </style>
  </head>
  <body${bodyClassName ? ` class="${bodyClassName}"` : ""}>
    ${mode === "catalog" ? `<div class="${catalogShellClassName}">${articleMarkup}</div>` : mode === "preview" ? `<div class="preview-shell">${articleMarkup}</div>` : articleMarkup}
  </body>
</html>`;
}

const catalogPreviewDocument: ResumeRenderDocument = {
  fullName: "John Doe",
  headline: "Senior platform engineer",
  location: "Austin, TX",
  contactItems: [{ field: "email", text: "john@example.com | john-doe.dev" }],
  sections: [
    {
      id: "section_summary",
      kind: "summary",
      label: "Summary",
      text: "Builds reliable developer platforms and internal hiring tools that remove manual operational drag.",
      bullets: [],
      entries: [],
    },
    {
      id: "section_core_skills",
      kind: "skills",
      label: "Core Skills",
      text: null,
      bullets: [
        { id: "preview_skill_1", text: "TypeScript" },
        { id: "preview_skill_2", text: "Distributed Systems" },
        { id: "preview_skill_3", text: "AWS" },
        { id: "preview_skill_4", text: "React" },
      ],
      entries: [],
    },
    {
      id: "section_additional_skills",
      kind: "skills",
      label: "Additional Skills",
      text: null,
      bullets: [
        { id: "preview_add_skill_1", text: "Playwright" },
        { id: "preview_add_skill_2", text: "CI/CD" },
      ],
      entries: [],
    },
    {
      id: "section_experience",
      kind: "experience",
      label: "Experience",
      text: null,
      bullets: [],
      entries: [
        {
          id: "entry_preview_experience",
          title: "Senior platform engineer",
          subtitle: "Northstar",
          location: null,
          dateRange: "2021 - Present",
          startDate: "2021",
          endDate: null,
          isCurrent: true,
          heading: "Senior platform engineer | Northstar | 2021 - Present",
          summary:
            "Leads platform reliability, workflow automation, and internal developer tooling.",
          bullets: [
            {
              id: "preview_exp_bullet_1",
              text: "Cut deployment rollback time by 43% through safer release automation.",
            },
          ],
        },
        {
          id: "entry_preview_experience_previous",
          title: "Software engineer",
          subtitle: "Beacon Labs",
          location: null,
          dateRange: "2018 - 2021",
          startDate: "2018",
          endDate: "2021",
          isCurrent: false,
          heading: "Software engineer | Beacon Labs | 2018 - 2021",
          summary:
            "Shipped customer-facing product workflows and API integrations for growth teams.",
          bullets: [],
        },
      ],
    },
    {
      id: "section_projects",
      kind: "projects",
      label: "Projects",
      text: null,
      bullets: [],
      entries: [
        {
          id: "entry_preview_project",
          title: "Interview copilot",
          subtitle: "Technical lead",
          location: null,
          dateRange: null,
          startDate: null,
          endDate: null,
          isCurrent: false,
          heading: "Interview copilot | Technical lead",
          summary:
            "Built an interview prep workspace with typed prompts, scoring, and export flows.",
          bullets: [
            {
              id: "preview_project_bullet_1",
              text: "Increased weekly returning users by 28%.",
            },
          ],
        },
        {
          id: "entry_preview_project_second",
          title: "Hiring pipeline analytics",
          subtitle: "Builder",
          location: null,
          dateRange: null,
          startDate: null,
          endDate: null,
          isCurrent: false,
          heading: "Hiring pipeline analytics | Builder",
          summary:
            "Created dashboards that surfaced interview bottlenecks and approval lag.",
          bullets: [],
        },
      ],
    },
    {
      id: "section_certifications",
      kind: "certifications",
      label: "Certifications",
      text: null,
      bullets: [],
      entries: [
        {
          id: "entry_preview_certification",
          title: "AWS Certified Developer",
          subtitle: "Amazon Web Services",
          location: null,
          dateRange: "2024",
          startDate: "2024",
          endDate: null,
          isCurrent: false,
          heading: "AWS Certified Developer | Amazon Web Services | 2024",
          summary: null,
          bullets: [
            {
              id: "preview_cert_bullet_1",
              text: "Validated cloud delivery and systems operations depth.",
            },
          ],
        },
      ],
    },
    {
      id: "section_education",
      kind: "education",
      label: "Education",
      text: null,
      bullets: [],
      entries: [
        {
          id: "entry_preview_education",
          title: "BSc Computer Science",
          subtitle: "University of Texas",
          location: null,
          dateRange: "2018",
          startDate: "2018",
          endDate: null,
          isCurrent: false,
          heading: "BSc Computer Science | University of Texas | 2018",
          summary: null,
          bullets: [
            {
              id: "preview_edu_bullet_1",
              text: "Focused on distributed systems and human-centered tooling.",
            },
          ],
        },
      ],
    },
    {
      id: "section_languages",
      kind: "skills",
      label: "Languages",
      text: null,
      bullets: [
        { id: "preview_lang_1", text: "English - Native" },
        { id: "preview_lang_2", text: "Spanish - Professional" },
      ],
      entries: [],
    },
  ],
};

export function renderResumeTemplateCatalogPreviewHtml(
  templateId: ResumeTemplateId,
  options?: { layout?: "thumbnail" | "panel" },
): string {
  return renderResumeTemplateHtml(
    {
      renderDocument: catalogPreviewDocument,
      templateId,
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: templateId,
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        keepSessionAlive: false,
        discoveryOnly: false,
      },
    },
    { mode: "catalog", catalogLayout: options?.layout ?? "thumbnail" },
  );
}

export { listLocalResumeTemplates } from "./job-finder-resume-catalog";
