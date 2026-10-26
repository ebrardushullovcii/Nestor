import type { ProfileCopilotPatchGroup } from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import {
  createUniqueId,
  deriveRequestedDetail,
  findPendingRelevantReviewItems,
  getMatchingResolutionStatus,
  normalizeFactText,
  trimNonEmptyString,
} from "./profile-copilot-helpers";

export type PatchApplyMode = ProfileCopilotPatchGroup["applyMode"];
export type PatchOperationName =
  | "replace_identity_fields"
  | "replace_work_eligibility_fields"
  | "replace_professional_summary_fields"
  | "replace_narrative_fields"
  | "replace_application_identity_fields"
  | "replace_skill_group_fields"
  | "replace_profile_list_fields"
  | "replace_search_preferences_fields";
export type ReviewDomain =
  | "identity"
  | "work_eligibility"
  | "professional_summary"
  | "narrative"
  | "search_preferences"
  | null;

export interface FieldDescriptor<TValue> {
  aliases: readonly string[];
  applyMode: PatchApplyMode;
  key: string;
  matchesRequest?: (normalizedRequest: string) => boolean;
  operation: PatchOperationName;
  reviewDomain: ReviewDomain;
  title: string;
  parseValue: (
    detail: string | null,
    normalizedRequest: string,
  ) => TValue | undefined;
  readCurrentValue: (input: ReviseCandidateProfileInput) => TValue;
}

export function uniqueNonEmpty(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value.trim();
    const normalized = normalizeFactText(trimmed);

    if (!trimmed || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(trimmed);
  }

  return result;
}

export function parseStringList(detail: string): string[] {
  return uniqueNonEmpty(
    detail
      .replace(/\s+and\s+/gi, ",")
      .split(/[\n,;|]/)
      .map((value) => value.trim()),
  );
}

export function requestLooksLikeClear(normalizedRequest: string): boolean {
  return /\b(clear|delete|remove|erase|reset|blank|empty)\b/.test(
    normalizedRequest,
  );
}

export function parseNullableText(
  detail: string | null,
  normalizedRequest: string,
): string | null | undefined {
  if (requestLooksLikeClear(normalizedRequest)) {
    return null;
  }

  if (!detail) {
    return undefined;
  }

  return trimNonEmptyString(detail) ?? null;
}

export function parseRequiredText(detail: string | null): string | undefined {
  if (!detail) {
    return undefined;
  }

  return trimNonEmptyString(detail) ?? undefined;
}

export function parseNullableList(
  detail: string | null,
  normalizedRequest: string,
): string[] | undefined {
  if (requestLooksLikeClear(normalizedRequest)) {
    return [];
  }

  if (!detail) {
    return undefined;
  }

  return parseStringList(detail);
}

export function parseNullableBoolean(
  detail: string | null,
  normalizedRequest: string,
): boolean | null | undefined {
  if (requestLooksLikeClear(normalizedRequest)) {
    return null;
  }

  const normalized = normalizeFactText(detail ?? normalizedRequest);

  if (!normalized) {
    return undefined;
  }

  if (
    /\b(yes|true|required|need|needs|willing|available|open|enabled|enable)\b/.test(
      normalized,
    )
  ) {
    return true;
  }

  if (/\b(no|false|not|dont|don't|disabled|disable|none)\b/.test(normalized)) {
    return false;
  }

  return undefined;
}

export function parseNullableInteger(
  detail: string | null,
  normalizedRequest: string,
): number | null | undefined {
  if (requestLooksLikeClear(normalizedRequest)) {
    return null;
  }

  const source = detail ?? normalizedRequest;
  const match = source.match(/\b(\d{1,6})\b/);
  const value = Number(match?.[1] ?? Number.NaN);

  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseSalaryCurrency(
  detail: string | null,
  normalizedRequest: string,
): string | null | undefined {
  if (requestLooksLikeClear(normalizedRequest)) {
    return null;
  }

  const normalized = normalizeFactText(detail ?? normalizedRequest);
  const currencyCode = normalized.match(
    /\b(usd|eur|gbp|chf|cad|aud|nzd|jpy|cny|inr|sek|nok|dkk|pln|czk|huf|ron|bgn|try|all|mkd|rsd|bam)\b/i,
  )?.[1];

  if (currencyCode) {
    return currencyCode.toUpperCase();
  }

  const currencyNames: ReadonlyArray<readonly [RegExp, string]> = [
    [/\beuros?\b/i, "EUR"],
    [/\b(?:us )?dollars?\b/i, "USD"],
    [/\b(?:british )?pounds?\b|\bsterling\b/i, "GBP"],
    [/\bswiss francs?\b/i, "CHF"],
  ];
  const namedCurrency = currencyNames.find(([pattern]) =>
    pattern.test(detail ?? normalizedRequest),
  );

  return namedCurrency?.[1];
}

export function parseTailoringMode(
  detail: string | null,
  normalizedRequest: string,
): "conservative" | "balanced" | "aggressive" | undefined {
  const normalized = normalizeFactText(detail ?? normalizedRequest);

  if (normalized.includes("conservative") || normalized.includes("light")) {
    return "conservative";
  }

  if (normalized.includes("balanced") || normalized.includes("tailored")) {
    return "balanced";
  }

  if (normalized.includes("aggressive")) {
    return "aggressive";
  }

  return undefined;
}

export function parseApprovalMode(
  detail: string | null,
  normalizedRequest: string,
):
  | "draft_only"
  | "review_before_submit"
  | "one_click_approve"
  | "full_auto"
  | undefined {
  const normalized = normalizeFactText(detail ?? normalizedRequest);

  if (normalized.includes("draft only")) {
    return "draft_only";
  }

  if (
    normalized.includes("review before submit") ||
    normalized.includes("review before sending")
  ) {
    return "review_before_submit";
  }

  if (
    normalized.includes("one click approve") ||
    normalized.includes("one-click approve")
  ) {
    return "one_click_approve";
  }

  if (
    normalized.includes("full auto") ||
    normalized.includes("fully automatic")
  ) {
    return "full_auto";
  }

  return undefined;
}

function normalizeComparableEntry(value: unknown): unknown {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value == null
  ) {
    return normalizeFactText(value);
  }

  return value;
}

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableEntry(entry));
  }

  if (typeof value === "string") {
    return normalizeFactText(value);
  }

  return value;
}

export function valuesMatch(
  currentValue: unknown,
  nextValue: unknown,
): boolean {
  return (
    JSON.stringify(normalizeComparableValue(currentValue)) ===
    JSON.stringify(normalizeComparableValue(nextValue))
  );
}

export function requestMentionsAlias(
  normalizedRequest: string,
  aliases: readonly string[],
): boolean {
  return aliases.some((alias) =>
    normalizedRequest.includes(normalizeFactText(alias)),
  );
}

function buildOperation(
  operation: PatchOperationName,
  key: string,
  value: unknown,
): ProfileCopilotPatchGroup["operations"][number] {
  return {
    operation,
    value: {
      [key]: value,
    },
  } as ProfileCopilotPatchGroup["operations"][number];
}

export function buildFieldPatchGroup<TValue>(
  input: ReviseCandidateProfileInput,
  descriptor: FieldDescriptor<TValue>,
  nextValue: TValue,
): ProfileCopilotPatchGroup | null {
  const currentValue = descriptor.readCurrentValue(input);
  const matchingReviewItems = descriptor.reviewDomain
    ? findPendingRelevantReviewItems(
        input,
        (item) =>
          item.target.domain === descriptor.reviewDomain &&
          item.target.key === descriptor.key,
      )
    : [];
  const operations: ProfileCopilotPatchGroup["operations"] = [];

  if (!valuesMatch(currentValue, nextValue)) {
    operations.push(
      buildOperation(descriptor.operation, descriptor.key, nextValue),
    );
  }

  if (matchingReviewItems.length > 0) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: matchingReviewItems.map((item) => item.id),
      resolutionStatus:
        typeof nextValue === "string" ||
        typeof nextValue === "number" ||
        typeof nextValue === "boolean"
          ? getMatchingResolutionStatus(matchingReviewItems[0]!, nextValue)
          : "edited",
    });
  }

  if (operations.length === 0) {
    return null;
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: !valuesMatch(currentValue, nextValue)
      ? `Update ${descriptor.title}`
      : `Confirm ${descriptor.title}`,
    applyMode: descriptor.applyMode,
    operations,
    createdAt: new Date().toISOString(),
  };
}

export function buildGenericExplicitFieldPatchGroupsFromDescriptors(
  input: ReviseCandidateProfileInput,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
): ProfileCopilotPatchGroup[] {
  const normalizedRequest = normalizeFactText(input.request);
  const candidateDescriptors = [...descriptors]
    .filter((descriptor) =>
      descriptor.matchesRequest
        ? descriptor.matchesRequest(normalizedRequest)
        : requestMentionsAlias(normalizedRequest, descriptor.aliases),
    )
    .sort((left, right) => {
      const leftSpecificity = Math.max(
        ...left.aliases.map((alias) => alias.length),
      );
      const rightSpecificity = Math.max(
        ...right.aliases.map((alias) => alias.length),
      );

      return rightSpecificity - leftSpecificity;
    });

  const { acceptedSpans } = collectCommandLikeSpans(input.request, descriptors);
  const hasAcceptedForeignSpan = acceptedSpans.some(
    (span) => span.family !== null,
  );

  // Single-intent requests keep the exact legacy parse (global detail
  // derivation and global clear detection) so existing behavior, including
  // specialist-owned phrasing fallbacks, is unchanged. The moment another
  // command family (salary, displayed location, target roles) appears, clause
  // segmentation is mandatory so no value absorbs the later command.
  if (candidateDescriptors.length <= 1 && !hasAcceptedForeignSpan) {
    const legacyGroup = buildLegacyExplicitFieldPatchGroup(
      input,
      descriptors,
      normalizedRequest,
    );

    return legacyGroup ? [legacyGroup] : [];
  }

  return buildMultiFieldPatchGroups(input, descriptors);
}

function buildLegacyExplicitFieldPatchGroup(
  input: ReviseCandidateProfileInput,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
  normalizedRequest: string,
): ProfileCopilotPatchGroup | null {
  const detail = deriveRequestedDetail(input.request);
  const orderedDescriptors = [...descriptors].sort((left, right) => {
    const leftSpecificity = Math.max(
      ...left.aliases.map((alias) => alias.length),
    );
    const rightSpecificity = Math.max(
      ...right.aliases.map((alias) => alias.length),
    );

    return rightSpecificity - leftSpecificity;
  });

  for (const descriptor of orderedDescriptors) {
    const matchesRequest = descriptor.matchesRequest
      ? descriptor.matchesRequest(normalizedRequest)
      : requestMentionsAlias(normalizedRequest, descriptor.aliases);

    if (!matchesRequest) {
      continue;
    }

    const nextValue = descriptor.parseValue(detail, normalizedRequest);

    if (nextValue === undefined) {
      continue;
    }

    return buildFieldPatchGroup(input, descriptor, nextValue);
  }

  return null;
}

/**
 * Command families owned by specialist builders (salary, displayed location,
 * target roles). Their mentions are never staged by the generic descriptor
 * pipeline, but they must still cut clauses so descriptor values never absorb
 * a later command's text.
 */
export type ForeignCommandFamily =
  | "salary"
  | "current_location"
  | "target_roles";

interface DescriptorAliasSpan {
  readonly descriptorIndex: number;
  readonly end: number;
  readonly family: ForeignCommandFamily | null;
  readonly start: number;
}

export interface CommandClause {
  readonly descriptorIndex: number;
  readonly family: ForeignCommandFamily | null;
  readonly isAcceptedCommand: boolean;
  readonly normalizedText: string;
  readonly text: string;
}

const clauseSeparatorPattern = /(?:\band\b|[,;])/gi;
// Non-global twin for prose detection; global lastIndex state must never leak
// between calls.
const clauseSeparatorTestPattern = /(?:\band\b|[,;])/i;
// Sentence-style follow-on commands ("...to x@y.com. Set my phone to 555") cut
// at the trailing command verb instead of at every period, which would corrupt
// values such as emails or "Node.js".
const trailingCommandVerbPattern =
  /\s*(?:[,;]|\b(?:and|then|also)\b|\.)?\s*(?:please\s+)?(?:set|update|change|make|switch|use)\s+(?:my\s+|the\s+|our\s+)?$/i;
const spanAssignmentMarkerPattern = /^\s*(?:to|as|is|should\s+be|:|=)\b/i;
const spanDirectValuePattern = /^\s*(?:yes|no)\b/i;
const clearVerbPrefixPattern =
  /\b(?:clear|delete|remove|erase|reset|blank|empty)\s+(?:my\s+|the\s+|our\s+)?$/i;
const clearVerbMaskPattern =
  /\b(?:clear|delete|remove|erase|reset|blank|empty)\b/g;

const foreignFamilyPatterns: ReadonlyArray<{
  readonly family: ForeignCommandFamily;
  readonly pattern: RegExp;
}> = [
  {
    family: "salary",
    pattern:
      /\b(?:salary|compensation|pay|wage|floor|min|minimum|max|maximum|target|range|expect(?:ed|ing|ations?)?)\b/gi,
  },
  {
    family: "current_location",
    pattern: /\b(?:displayed location|current location|location)\b/gi,
  },
  {
    family: "target_roles",
    pattern: /\b(?:target roles?|looking for)\b/gi,
  },
];

// "salary range is 120000", "expected salary to be 2k" and "minimum salary to
// 180000" all carry a modifier between the keyword and the assignment marker.
const salaryAssignmentTailPattern =
  /^\s*(?:salary|compensation|pay|wage|range|expectations?|expect(?:ed|ing)?|minimum|min|maximum|max|target|floor|top|cap)?\s*(?:is|are|should\s+be|to(?:\s+(?:only\s+)?be)?|of|at|:|=)\s*(?:US\$|[$€£])?\s*[\d,.]+/i;
const salaryBareAmountTailPattern = /^\s*(?:US\$|[$€£])?\s*[\d,.]+/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A mention only counts as a field command when the text right after the alias
 * looks like an assignment ("email to x", "phone: y") or the text right before
 * it is a clear verb ("delete my email"). Mentions that fail this check are
 * treated as prose inside another field's value instead of commands.
 */
function isCommandLikeSpan(
  rawRequest: string,
  span: DescriptorAliasSpan,
): boolean {
  const tailAfterAlias = rawRequest.slice(span.end, span.end + 18);
  const prefixBeforeAlias = rawRequest.slice(
    Math.max(0, span.start - 32),
    span.start,
  );

  return (
    spanAssignmentMarkerPattern.test(tailAfterAlias) ||
    spanDirectValuePattern.test(tailAfterAlias) ||
    clearVerbPrefixPattern.test(prefixBeforeAlias)
  );
}

/**
 * A salary keyword inside an unfinished value ("set my headline to Pay 300 per
 * month") is prose, not a command. It stops being prose once a clause
 * separator sets it apart ("my email to a@b.com and my salary to 180000").
 */
function salaryMentionIsValueProse(
  rawRequest: string,
  previousSpanEnd: number | null,
  spanStart: number,
): boolean {
  if (previousSpanEnd === null) {
    return false;
  }

  const gap = rawRequest.slice(previousSpanEnd, spanStart);

  if (clauseSeparatorTestPattern.test(gap)) {
    return false;
  }

  // A fresh possessive phrase is also an explicit command boundary even when
  // the user omits punctuation or a connector: "email to a@b.com my expected
  // salary is 180000". Ordinary value prose such as "headline to Pay 300 per
  // month" has no such ownership marker and remains part of the field value.
  if (/\bmy\s*$/i.test(gap)) {
    return false;
  }

  return spanAssignmentMarkerPattern.test(gap);
}

function isForeignSpanCommandLike(
  rawRequest: string,
  span: DescriptorAliasSpan,
  previousSpanEnd: number | null,
): boolean {
  const tailAfterSpan = rawRequest.slice(span.end, span.end + 42);
  const prefixBeforeSpan = rawRequest.slice(
    Math.max(0, span.start - 32),
    span.start,
  );

  if (clearVerbPrefixPattern.test(prefixBeforeSpan)) {
    return true;
  }

  if (span.family !== "salary") {
    return (
      spanAssignmentMarkerPattern.test(tailAfterSpan) ||
      spanDirectValuePattern.test(tailAfterSpan)
    );
  }

  if (
    !salaryAssignmentTailPattern.test(tailAfterSpan) &&
    !salaryBareAmountTailPattern.test(tailAfterSpan)
  ) {
    return false;
  }

  return !salaryMentionIsValueProse(rawRequest, previousSpanEnd, span.start);
}

function collectAllSpans(
  rawRequest: string,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
): DescriptorAliasSpan[] {
  const allSpans: DescriptorAliasSpan[] = [];

  descriptors.forEach((descriptor, descriptorIndex) => {
    for (const alias of descriptor.aliases) {
      const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "gi");

      for (const match of rawRequest.matchAll(pattern)) {
        const start = match.index;

        if (start === undefined) {
          continue;
        }

        allSpans.push({
          descriptorIndex,
          end: start + match[0].length,
          family:
            descriptor.key === "currentLocation" ? "current_location" : null,
          start,
        });
      }
    }
  });

  for (const { family, pattern } of foreignFamilyPatterns) {
    for (const match of rawRequest.matchAll(pattern)) {
      const start = match.index;

      if (start === undefined) {
        continue;
      }

      allSpans.push({
        descriptorIndex: -1,
        end: start + match[0].length,
        family,
        start,
      });
    }
  }

  // Longest span wins an overlap so "secondary email" suppresses the nested
  // "email" mention and "salary expectations answer" suppresses the nested
  // "salary"/"expectations" keywords instead of firing competing clauses.
  const keptSpans: DescriptorAliasSpan[] = [];
  const orderedBySpecificity = [...allSpans].sort((left, right) => {
    const leftLength = left.end - left.start;
    const rightLength = right.end - right.start;

    return rightLength - leftLength || left.start - right.start;
  });

  for (const span of orderedBySpecificity) {
    if (
      keptSpans.some((kept) => span.start < kept.end && kept.start < span.end)
    ) {
      continue;
    }

    keptSpans.push(span);
  }

  const orderedByPosition = keptSpans.sort(
    (left, right) => left.start - right.start,
  );

  // Split keywords of one phrase ("my expected salary", "minimum salary",
  // "salary range") form a single command span; two distinct commands joined
  // by "and"/"," never merge because their gap carries a separator.
  const mergedByPhrase: DescriptorAliasSpan[] = [];

  for (const span of orderedByPosition) {
    const previous = mergedByPhrase.at(-1);

    if (
      previous &&
      span.family !== null &&
      previous.family === span.family &&
      span.descriptorIndex === -1 &&
      previous.descriptorIndex === -1 &&
      /^[\s-]*$/.test(rawRequest.slice(previous.end, span.start))
    ) {
      mergedByPhrase[mergedByPhrase.length - 1] = {
        descriptorIndex: -1,
        end: span.end,
        family: span.family,
        start: previous.start,
      };
      continue;
    }

    mergedByPhrase.push(span);
  }

  return mergedByPhrase;
}

function collectCommandLikeSpans(
  rawRequest: string,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
): {
  acceptedSpans: DescriptorAliasSpan[];
  segmentationSpans: DescriptorAliasSpan[];
} {
  const orderedByPosition = collectAllSpans(rawRequest, descriptors);
  const acceptedSpans: DescriptorAliasSpan[] = [];
  let previousSpanEnd: number | null = null;

  for (const span of orderedByPosition) {
    const isCommandLike =
      span.descriptorIndex === -1
        ? isForeignSpanCommandLike(rawRequest, span, previousSpanEnd)
        : isCommandLikeSpan(rawRequest, span);

    if (isCommandLike) {
      acceptedSpans.push(span);
    }

    previousSpanEnd = span.end;
  }

  // A rejected mention may still act as a pure clause boundary when it dangles
  // at the very end of the request ("set my tools to grep and my email"): the
  // boundary excises it from the previous field's value without becoming a
  // command itself. Mentions followed by more prose stay inside that prose.
  const lastKeptSpan = orderedByPosition.at(-1);
  const boundaryOnlySpans = orderedByPosition.filter(
    (span) =>
      !acceptedSpans.includes(span) &&
      span === lastKeptSpan &&
      rawRequest.slice(span.end).trim() === "",
  );

  return {
    acceptedSpans,
    segmentationSpans: [...acceptedSpans, ...boundaryOnlySpans].sort(
      (left, right) => left.start - right.start,
    ),
  };
}

function buildClausesFromSpans(
  rawRequest: string,
  spans: ReadonlyArray<DescriptorAliasSpan>,
  acceptedSpanSet: ReadonlySet<DescriptorAliasSpan>,
): CommandClause[] {
  const clauses: CommandClause[] = [];
  let clauseStart = 0;

  spans.forEach((span, index) => {
    const hasFollowingSpan = index + 1 < spans.length;
    const followingSpan = hasFollowingSpan ? spans[index + 1]! : null;
    const boundaryEnd = hasFollowingSpan
      ? spans[index + 1]!.start
      : rawRequest.length;
    const gap = rawRequest.slice(span.end, boundaryEnd);
    // Cut just before the LAST separator in the gap so a trailing connector
    // such as "and" joins the next clause while separators that belong to the
    // value itself (commas in lists) stay put. The final field owns its whole
    // remainder: with no follow-up command, separators are part of the value.
    let cutOffsetWithinGap = gap.length;

    if (hasFollowingSpan) {
      for (const match of gap.matchAll(clauseSeparatorPattern)) {
        cutOffsetWithinGap = match.index ?? cutOffsetWithinGap;
      }

      if (cutOffsetWithinGap === gap.length) {
        const trailingVerbMatch = gap.match(trailingCommandVerbPattern);

        if (trailingVerbMatch && trailingVerbMatch.index !== undefined) {
          cutOffsetWithinGap = trailingVerbMatch.index;
        }
      }

      // A possessive phrase can introduce a follow-on command without an
      // explicit connector. Keep the preceding value, but cut its trailing
      // "my" before the accepted specialist span begins.
      if (cutOffsetWithinGap === gap.length && followingSpan !== null) {
        const ownershipMatch = gap.match(/\bmy\s*$/i);
        if (
          ownershipMatch?.index !== undefined &&
          acceptedSpanSet.has(followingSpan)
        ) {
          cutOffsetWithinGap = ownershipMatch.index;
        }
      }
    }

    const text = rawRequest.slice(clauseStart, span.end + cutOffsetWithinGap);

    clauses.push({
      descriptorIndex: span.descriptorIndex,
      family: span.family,
      isAcceptedCommand: acceptedSpanSet.has(span),
      normalizedText: normalizeFactText(text),
      text,
    });
    clauseStart = span.end + cutOffsetWithinGap;
  });

  // When one field is mentioned twice the later mention wins, but it keeps the
  // earlier mention's position in the emitted group order. Foreign clauses
  // never collapse: "expected salary" and "minimum salary" both belong to one
  // record of the same family and stay separate clauses.
  const retainedIndexes = new Map<number, number>();

  clauses.forEach((clause, index) => {
    if (clause.descriptorIndex !== -1) {
      retainedIndexes.set(clause.descriptorIndex, index);
    }
  });

  return clauses.filter(
    (clause, index) =>
      clause.descriptorIndex === -1 ||
      retainedIndexes.get(clause.descriptorIndex) === index,
  );
}

/**
 * Full clause segmentation for one request. Descriptor spans keep their
 * descriptor index; specialist-owned families are tagged so salary and
 * location/target-role builders can extract exactly their own clause.
 */
export function segmentCommandClauses(
  rawRequest: string,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
): CommandClause[] {
  const { acceptedSpans, segmentationSpans } = collectCommandLikeSpans(
    rawRequest,
    descriptors,
  );

  return buildClausesFromSpans(
    rawRequest,
    segmentationSpans,
    new Set(acceptedSpans),
  );
}

function buildMultiFieldPatchGroups(
  input: ReviseCandidateProfileInput,
  descriptors: ReadonlyArray<FieldDescriptor<unknown>>,
): ProfileCopilotPatchGroup[] {
  const { acceptedSpans, segmentationSpans } = collectCommandLikeSpans(
    input.request,
    descriptors,
  );

  if (acceptedSpans.length === 0) {
    return [];
  }

  const groups: ProfileCopilotPatchGroup[] = [];

  for (const clause of buildClausesFromSpans(
    input.request,
    segmentationSpans,
    new Set(acceptedSpans),
  )) {
    // Boundary-only mentions excise themselves from neighboring values but
    // must never be parsed into operations of their own, and specialist-owned
    // foreign clauses are only ever boundaries for descriptor parsing.
    if (!clause.isAcceptedCommand || clause.descriptorIndex === -1) {
      continue;
    }

    const descriptor = descriptors[clause.descriptorIndex];

    if (!descriptor) {
      continue;
    }

    const detail = deriveRequestedDetail(clause.text);

    // With an explicit value present, strip stray clear verbs from the clause
    // context so "remove duplicates from my workflow" parses as a value
    // instead of tripping the parsers' broad clear detection.
    const normalizedClause =
      detail === null
        ? clause.normalizedText
        : clause.normalizedText.replace(clearVerbMaskPattern, " ");
    const nextValue = descriptor.parseValue(detail, normalizedClause);

    if (nextValue === undefined) {
      continue;
    }

    const group = buildFieldPatchGroup(input, descriptor, nextValue);

    if (group) {
      groups.push(group);
    }
  }

  return groups;
}
