import type {
  CandidateProfile,
  JobSearchPreferences,
  ProfileCopilotPatchGroup,
  ProfileCopilotPatchOperation,
} from "@nestor/contracts";

/**
 * Target roles and locations are stored twice: on the profile (resume and
 * letter evidence) and in the search preferences (what Preferences shows and
 * what search reads). A person sees one list. The Assistant read both and
 * proposed one card per copy, so "add Site Reliability Engineer to my target
 * roles" cost two Apply presses, and a card that changed only the profile
 * copy left the list on screen unchanged.
 */
export const MIRRORED_PROFILE_LIST_FIELDS = [
  "targetRoles",
  "locations",
] as const;
export type MirroredProfileListField =
  (typeof MIRRORED_PROFILE_LIST_FIELDS)[number];

const LIST_LABEL: Record<MirroredProfileListField, string> = {
  targetRoles: "target roles",
  locations: "locations",
};

interface ListDelta {
  added: string[];
  removed: string[];
}

function listKey(value: string): string {
  return value.trim().toLowerCase();
}

function isMirroredField(key: string): key is MirroredProfileListField {
  return (MIRRORED_PROFILE_LIST_FIELDS as readonly string[]).includes(key);
}

export function diffProfileList(
  before: readonly string[],
  after: readonly string[],
): ListDelta {
  const beforeKeys = new Set(before.map(listKey));
  const afterKeys = new Set(after.map(listKey));
  return {
    added: after.filter((entry) => !beforeKeys.has(listKey(entry))),
    removed: before.filter((entry) => !afterKeys.has(listKey(entry))),
  };
}

function isEmptyDelta(delta: ListDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0;
}

/** Removes what the other copy lost and appends what it gained, once each. */
export function applyProfileListDelta(
  list: readonly string[],
  delta: ListDelta,
): string[] {
  const removedKeys = new Set(delta.removed.map(listKey));
  const next = list.filter((entry) => !removedKeys.has(listKey(entry)));
  const presentKeys = new Set(next.map(listKey));
  for (const entry of delta.added) {
    if (!presentKeys.has(listKey(entry))) {
      next.push(entry);
      presentKeys.add(listKey(entry));
    }
  }
  return next;
}

/**
 * After a card is applied: when it changed one copy of a mirrored list and
 * left the other alone, the other copy gets the same additions and removals.
 * Order edits stay on the copy they were made to.
 */
export function mirrorProfileListEdits(input: {
  before: {
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
  };
  after: { profile: CandidateProfile; searchPreferences: JobSearchPreferences };
}): { profile: CandidateProfile; searchPreferences: JobSearchPreferences } {
  let profile = input.after.profile;
  let searchPreferences = input.after.searchPreferences;
  for (const field of MIRRORED_PROFILE_LIST_FIELDS) {
    const profileDelta = diffProfileList(
      input.before.profile[field],
      input.after.profile[field],
    );
    const searchDelta = diffProfileList(
      input.before.searchPreferences[field],
      input.after.searchPreferences[field],
    );
    if (!isEmptyDelta(profileDelta) && isEmptyDelta(searchDelta)) {
      searchPreferences = {
        ...searchPreferences,
        [field]: applyProfileListDelta(searchPreferences[field], profileDelta),
      };
    } else if (!isEmptyDelta(searchDelta) && isEmptyDelta(profileDelta)) {
      profile = {
        ...profile,
        [field]: applyProfileListDelta(profile[field], searchDelta),
      };
    }
  }
  return { profile, searchPreferences };
}

type ListEffectSide = "profile_removal" | "search_replace" | "profile_replace";

interface ListEffect {
  side: ListEffectSide;
  fields: Map<MirroredProfileListField, ListDelta>;
}

/**
 * What a card does to the mirrored lists, when that is all it does. Removals
 * name their entries, so they count even when the profile copy has drifted
 * and lacks one.
 */
function describeListEffect(
  operations: readonly ProfileCopilotPatchOperation[],
  lists: {
    profile: Pick<CandidateProfile, MirroredProfileListField>;
    searchPreferences: Pick<JobSearchPreferences, MirroredProfileListField>;
  },
): ListEffect | null {
  if (operations.length !== 1) {
    return null;
  }
  const [operation] = operations;
  if (!operation) {
    return null;
  }
  const fields = new Map<MirroredProfileListField, ListDelta>();
  if (operation.operation === "remove_profile_list_entries") {
    if (!isMirroredField(operation.field)) {
      return null;
    }
    fields.set(operation.field, { added: [], removed: [...operation.values] });
    return { side: "profile_removal", fields };
  }
  if (
    operation.operation !== "replace_profile_list_fields" &&
    operation.operation !== "replace_search_preferences_fields"
  ) {
    return null;
  }
  const entries = Object.entries(operation.value).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) {
    return null;
  }
  const side: ListEffectSide =
    operation.operation === "replace_profile_list_fields"
      ? "profile_replace"
      : "search_replace";
  const source =
    side === "profile_replace" ? lists.profile : lists.searchPreferences;
  for (const [key, value] of entries) {
    if (!isMirroredField(key) || !Array.isArray(value)) {
      return null;
    }
    fields.set(
      key,
      diffProfileList(
        source[key],
        value.filter((entry): entry is string => typeof entry === "string"),
      ),
    );
  }
  return { side, fields };
}

function sameEffect(left: ListEffect, right: ListEffect): boolean {
  if (left.fields.size !== right.fields.size) {
    return false;
  }
  const sameSet = (a: readonly string[], b: readonly string[]) => {
    const aKeys = new Set(a.map(listKey));
    const bKeys = new Set(b.map(listKey));
    return (
      aKeys.size === bKeys.size && [...aKeys].every((key) => bKeys.has(key))
    );
  };
  let changesSomething = false;
  for (const [field, delta] of left.fields) {
    const other = right.fields.get(field);
    if (
      !other ||
      !sameSet(delta.added, other.added) ||
      !sameSet(delta.removed, other.removed)
    ) {
      return false;
    }
    changesSomething ||= !isEmptyDelta(delta);
  }
  return changesSomething;
}

const SIDE_PRIORITY: Record<ListEffectSide, number> = {
  // A removal names what goes ("Remove target role: X"), the clearest card.
  profile_removal: 3,
  // The search copy is the list Preferences shows.
  search_replace: 2,
  profile_replace: 1,
};

function joinNames(values: readonly string[]): string {
  if (values.length <= 1) {
    return values.join("");
  }
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

export function summarizeListEffect(
  fields: ReadonlyMap<MirroredProfileListField, ListDelta>,
): string {
  const parts = [...fields.entries()].flatMap(([field, delta]) => {
    const label = LIST_LABEL[field];
    if (delta.added.length > 0 && delta.removed.length === 0) {
      return [`add ${joinNames(delta.added)} to ${label}`];
    }
    if (delta.removed.length > 0 && delta.added.length === 0) {
      return [`remove ${joinNames(delta.removed)} from ${label}`];
    }
    if (delta.added.length > 0) {
      return [
        `update ${label}: add ${joinNames(delta.added)}, remove ${joinNames(delta.removed)}`,
      ];
    }
    return [];
  });
  const sentence = parts.join("; ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * One reply that changes the same list twice, once per stored copy, becomes
 * one card. The copy the card does not name follows when it is applied
 * ({@link mirrorProfileListEdits}).
 */
export function mergeMirroredListHalves<
  TGroup extends Pick<ProfileCopilotPatchGroup, "operations" | "summary">,
>(
  groups: readonly TGroup[],
  lists: {
    profile: Pick<CandidateProfile, MirroredProfileListField>;
    searchPreferences: Pick<JobSearchPreferences, MirroredProfileListField>;
  },
): TGroup[] {
  const effects = groups.map((group) =>
    describeListEffect(group.operations, lists),
  );
  const dropped = new Set<number>();
  const renamed = new Map<number, string>();
  for (let left = 0; left < groups.length; left += 1) {
    const leftEffect = effects[left];
    if (!leftEffect || dropped.has(left)) continue;
    for (let right = left + 1; right < groups.length; right += 1) {
      const rightEffect = effects[right];
      if (
        !rightEffect ||
        dropped.has(right) ||
        leftEffect.side === rightEffect.side ||
        (leftEffect.side !== "search_replace" &&
          rightEffect.side !== "search_replace") ||
        !sameEffect(leftEffect, rightEffect)
      ) {
        continue;
      }
      const keep =
        SIDE_PRIORITY[leftEffect.side] >= SIDE_PRIORITY[rightEffect.side]
          ? left
          : right;
      const drop = keep === left ? right : left;
      dropped.add(drop);
      renamed.set(keep, summarizeListEffect(leftEffect.fields));
      if (drop === left) break;
    }
  }
  return groups.flatMap((group, index) => {
    if (dropped.has(index)) return [];
    const summary = renamed.get(index);
    return [summary ? { ...group, summary } : group];
  });
}
