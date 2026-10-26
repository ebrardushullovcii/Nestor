import { useSitePage } from "@renderer/features/job-lists/use-site-page";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import type {
  CandidateProfile,
  JobSearchPreferences,
  ResumeImportFieldCandidateSummary,
} from "@nestor/contracts";
import type { ProfileBackgroundArrays } from "../components/profile/profile-field-array-types";
import {
  buildProfilePayload,
  buildSearchPreferencesPayload,
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  hasProfileDraftChanges,
  hasSearchPreferencesDraftChanges,
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../lib/profile-editor";
import { buildProfileScreenViewModel } from "../lib/profile-screen-view-model";

export const backgroundMergedNoticeMessage =
  "Profile was updated in the background. Your unsaved edits were kept; review the merged fields before saving.";
export const backgroundConflictNoticeMessage =
  "Changes were made in the background that could not be merged with your unsaved edits. Discard your edits to load the latest saved data, or save to overwrite the background changes.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Exact root names of every useFieldArray subscription this hook creates.
// RHF re-publishes each root with a bare values payload whenever array state
// resyncs (mount, canonical reseeds), which must never read as a user edit;
// see the draft-edit subscription in useProfileScreenForms.
const FIELD_ARRAY_ROOT_NAMES = new Set([
  "records.experiences",
  "records.education",
  "records.certifications",
  "projects",
  "links",
  "languages",
  "proofBank",
]);

// Structural row mutations ARE genuine user edits even though the root resync
// channel stays filtered. These screens consume exactly these two mutators
// (append/remove — no reorder UI exists here), so wrapping them at the hook
// boundary yields exactly one signal per user invocation while mount/reseed
// resyncs keep flowing through the raw, filtered channel.
const FIELD_ARRAY_USER_MUTATORS = ["append", "remove"] as const;

function wrapFieldArrayStructuralMutators<TFieldArray>(
  fieldArray: TFieldArray,
  notifyDraftEdited: () => void,
): TFieldArray {
  let wrapped = { ...fieldArray };
  for (const mutator of FIELD_ARRAY_USER_MUTATORS) {
    const original = (wrapped as Record<string, unknown>)[mutator];
    if (typeof original !== "function") {
      continue;
    }
    const replacement = (...args: unknown[]) => {
      const result = (original as (...fnArgs: unknown[]) => unknown)(...args);
      notifyDraftEdited();
      return result;
    };
    wrapped = {
      ...wrapped,
      [mutator]: replacement,
    } as TFieldArray;
  }
  return wrapped;
}

function hasDirtySignal(dirtyShape: unknown): boolean {
  if (dirtyShape === true) {
    return true;
  }

  if (Array.isArray(dirtyShape)) {
    return dirtyShape.some((entry) => hasDirtySignal(entry));
  }

  if (isRecord(dirtyShape)) {
    return Object.values(dirtyShape).some((entry) => hasDirtySignal(entry));
  }

  return false;
}

function stableRecordId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;

  return typeof id === "string" && id.trim().length > 0 ? id : null;
}

export type DirtyEditorMergeOutcome =
  | { status: "merged"; value: unknown }
  | { status: "conflict"; reason: string };

type ProfileEditorSurface = "profile" | "preferences";
type BackgroundConflictSurfaces = Record<ProfileEditorSurface, boolean>;

// Notice shown when one surface resolves its own background update: while any
// other surface still has an outstanding conflict, keep surfacing the conflict
// instruction so the visible choice matches the actual background state
// instead of a stale "merged successfully" message.
function resolvedBackgroundMergeNotice(
  otherSurfaceConflicted: boolean,
  resolvedNotice: string | null,
): string | null {
  return otherSurfaceConflicted
    ? backgroundConflictNoticeMessage
    : resolvedNotice;
}

// Overlay the user's dirty draft values onto freshly built canonical editor
// values so a meaningful background update adopts every untouched field while
// dirty fields keep the user's exact input. Applied per leaf because RHF's
// own keepDirtyValues reset overlays whole subtrees whenever any nested field
// is dirty, which would resurrect stale untouched sibling values under a
// partially edited section.
//
// Arrays of records merge by stable id: dirty rows are mapped by id onto the
// incoming canonical order, so reorders and appends stay safe and a removed
// id can never resurrect as a sparse ghost row. Any unmatchable shape — a
// dirty record missing from the incoming data, duplicate or invalid ids, or
// a dirty list whose rows are not id-bearing records — fails the whole merge
// atomically so callers can keep the local draft untouched.
function overlayDirtyEditorPaths(
  incoming: unknown,
  draft: unknown,
  dirtyShape: unknown,
): DirtyEditorMergeOutcome {
  if (dirtyShape === true) {
    return draft !== undefined
      ? { status: "merged", value: draft }
      : {
          status: "conflict",
          reason: "The edited value is no longer present.",
        };
  }

  if (Array.isArray(dirtyShape)) {
    if (!Array.isArray(incoming) || !Array.isArray(draft)) {
      return {
        status: "conflict",
        reason: "An edited list changed shape in the background.",
      };
    }

    const incomingRows = incoming as unknown[];
    const draftRows = draft as unknown[];
    type DirtyRowMatch = {
      id: string;
      draftRow: unknown;
      rowDirtyShape: unknown;
    };
    const dirtyRows: DirtyRowMatch[] = [];

    for (const [index, rowDirtyShape] of dirtyShape.entries()) {
      if (!hasDirtySignal(rowDirtyShape)) {
        continue;
      }

      const draftRow = draftRows[index];
      const id = stableRecordId(draftRow);

      if (id === null) {
        return {
          status: "conflict",
          reason: "An edited list row cannot be matched safely.",
        };
      }

      dirtyRows.push({ id, draftRow, rowDirtyShape });
    }

    if (dirtyRows.length === 0) {
      return { status: "merged", value: incoming };
    }

    const incomingRowById = new Map<string, unknown>();
    const incomingIds = new Set<string>();

    for (const row of incomingRows) {
      const id = stableRecordId(row);

      if (id === null || incomingIds.has(id)) {
        return {
          status: "conflict",
          reason: "Background list rows cannot be identified uniquely.",
        };
      }

      incomingIds.add(id);
      incomingRowById.set(id, row);
    }

    const mergedRowById = new Map<string, unknown>();

    for (const dirtyRow of dirtyRows) {
      if (mergedRowById.has(dirtyRow.id)) {
        return {
          status: "conflict",
          reason: "Edited list rows cannot be identified uniquely.",
        };
      }

      const incomingRow = incomingRowById.get(dirtyRow.id);

      if (!incomingIds.has(dirtyRow.id) || incomingRow === undefined) {
        return {
          status: "conflict",
          reason: "An edited record no longer exists in the background data.",
        };
      }

      const rowOutcome = overlayDirtyEditorPaths(
        incomingRow,
        dirtyRow.draftRow,
        dirtyRow.rowDirtyShape,
      );

      if (rowOutcome.status === "conflict") {
        return rowOutcome;
      }

      mergedRowById.set(dirtyRow.id, rowOutcome.value);
    }

    const mergedRows = incomingRows.map((row) => {
      const id = stableRecordId(row);
      const mergedRow = id === null ? undefined : mergedRowById.get(id);

      return mergedRow === undefined ? row : mergedRow;
    });

    return { status: "merged", value: mergedRows };
  }

  if (!isRecord(dirtyShape)) {
    return { status: "merged", value: incoming };
  }

  if (!isRecord(incoming)) {
    return {
      status: "conflict",
      reason: "An edited field changed shape in the background.",
    };
  }

  const merged: Record<string, unknown> = { ...incoming };
  const draftRecord: Record<string, unknown> = isRecord(draft) ? draft : {};

  for (const [key, fieldDirtyShape] of Object.entries(dirtyShape)) {
    const fieldOutcome = overlayDirtyEditorPaths(
      incoming[key],
      draftRecord[key],
      fieldDirtyShape,
    );

    if (fieldOutcome.status === "conflict") {
      return fieldOutcome;
    }

    merged[key] = fieldOutcome.value;
  }

  return { status: "merged", value: merged };
}

export function mergeDirtyEditorValues<TValue>(
  incomingValues: TValue,
  draftValues: TValue,
  dirtyFields: unknown,
): DirtyEditorMergeOutcome {
  const outcome = overlayDirtyEditorPaths(
    incomingValues,
    draftValues,
    dirtyFields,
  );

  return outcome.status === "merged"
    ? { status: "merged", value: outcome.value as TValue }
    : outcome;
}

function buildOrderedContentFingerprint(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

export function buildCanonicalAwareProfilePayload(input: {
  draftValues: ProfileEditorValues;
  dirtyFields: unknown;
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  profile: CandidateProfile;
}) {
  // Saving only sources must preserve the profile's exact saved values.
  // Round-tripping untouched editor fields can normalize resume inputs.
  const hasDirtyField = (value: unknown): boolean =>
    value === true ||
    (typeof value === "object" &&
      value !== null &&
      Object.values(value).some(hasDirtyField));
  if (!hasDirtyField(input.dirtyFields)) return { payload: input.profile };
  const mergeOutcome = mergeDirtyEditorValues(
    createProfileEditorValues(
      input.profile,
      input.latestResumeImportReviewCandidates,
    ),
    input.draftValues,
    input.dirtyFields,
  );

  return buildProfilePayload(
    input.profile,
    mergeOutcome.status === "merged"
      ? (mergeOutcome.value as ProfileEditorValues)
      : input.draftValues,
  );
}

export function useProfileScreenForms(input: {
  latestResumeImportReviewCandidates: readonly ResumeImportFieldCandidateSummary[];
  onDraftEdited?: () => void;
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
}) {
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  // One non-error status notice per surface while a background canonical
  // update was merged under kept dirty edits.
  const [backgroundMergeNotice, setBackgroundMergeNotice] = useState<
    string | null
  >(null);
  // An aborted merge marks its own editor surface conflicted until the draft
  // is discarded, an own-save echo lands, or a later snapshot adopts cleanly.
  // Tracking is per surface because one surface can resolve while the other
  // stays conflicted; the combined flag keeps the discard-and-reload
  // affordance visible whenever any conflict is outstanding.
  const [backgroundConflictSurfaces, setBackgroundConflictSurfaces] =
    useState<BackgroundConflictSurfaces>({
      preferences: false,
      profile: false,
    });
  const backgroundConflictSurfacesRef = useRef<BackgroundConflictSurfaces>({
    preferences: false,
    profile: false,
  });
  // Ref-first update so effects running in the same commit read the other
  // surface's conflict state without waiting for a render.
  const applyBackgroundConflictSurface = useCallback(
    (surface: ProfileEditorSurface, active: boolean) => {
      const next = {
        ...backgroundConflictSurfacesRef.current,
        [surface]: active,
      };
      backgroundConflictSurfacesRef.current = next;
      setBackgroundConflictSurfaces(next);
    },
    [],
  );
  const latestProfileRef = useRef(input.profile);
  const latestSearchPreferencesRef = useRef(input.searchPreferences);
  // Taken once: the preferences carry every job source, and serializing them
  // as each ref's initial value on every render made each Profile tab switch
  // stringify about 1 MB.
  const [initialFingerprints] = useState(() => ({
    profile: buildOrderedContentFingerprint(input.profile),
    reviewCandidates: buildOrderedContentFingerprint(
      input.latestResumeImportReviewCandidates,
    ),
    searchPreferences: buildOrderedContentFingerprint(input.searchPreferences),
  }));
  // Canonical-content fingerprints for the values each form currently owns.
  // A full workspace snapshot (a recovery, or an older route) brings profile
  // and searchPreferences with a new object identity even when nothing in
  // them changed; content fingerprints, not identity, decide when a form may
  // be reseeded so unrelated commits cannot erase dirty drafts.
  const loadedProfileContentFingerprintRef = useRef(
    initialFingerprints.profile,
  );
  const loadedReviewCandidatesContentFingerprintRef = useRef(
    initialFingerprints.reviewCandidates,
  );
  const loadedSearchPreferencesContentFingerprintRef = useRef(
    initialFingerprints.searchPreferences,
  );
  // Seen-fingerprints advance on every effect run (including conflicted
  // merges) so repeated snapshots cannot re-trigger handling, while the
  // loaded-fingerprints above only move when a form actually adopts content.
  const seenProfileContentFingerprintRef = useRef(initialFingerprints.profile);
  const seenReviewCandidatesContentFingerprintRef = useRef(
    initialFingerprints.reviewCandidates,
  );
  const seenSearchPreferencesContentFingerprintRef = useRef(
    initialFingerprints.searchPreferences,
  );
  // The newest canonical values seen from the workspace. Screens save against
  // these, so own-save echo detection matches the payload the save emitted
  // even when earlier background updates were left unmerged.
  const pendingCanonicalProfileRef = useRef(input.profile);
  const pendingCanonicalSearchPreferencesRef = useRef(input.searchPreferences);
  const currentProfileBaseline = latestProfileRef.current;
  const currentSearchPreferencesBaseline = latestSearchPreferencesRef.current;

  // Rebuilt only when the saved values change, not on every render.
  const profileDefaultValues = useMemo(
    () =>
      createProfileEditorValues(
        input.profile,
        input.latestResumeImportReviewCandidates,
      ),
    [input.profile, input.latestResumeImportReviewCandidates],
  );
  const preferencesDefaultValues = useMemo(
    () => createSearchPreferencesEditorValues(input.searchPreferences),
    [input.searchPreferences],
  );
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: profileDefaultValues,
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: preferencesDefaultValues,
  });

  // A rejected save's message must not outlive the correction: the moment
  // either form changes again, the footer stops claiming the data is invalid.
  useEffect(() => {
    if (!validationMessage) {
      return undefined;
    }
    const subscriptions = [
      profileForm.watch(() => setValidationMessage(null)),
      preferencesForm.watch(() => setValidationMessage(null)),
    ];
    return () => {
      for (const subscription of subscriptions) {
        subscription.unsubscribe();
      }
    };
  }, [validationMessage, profileForm, preferencesForm]);

  // Raised only around this hook's own canonical reseeds as defense in depth
  // for synchronous reset notifications; the name filter below carries the
  // primary semantics.
  const suppressDraftEditSignalRef = useRef(false);
  const runWithoutDraftEditSignal = useCallback(<T>(run: () => T): T => {
    suppressDraftEditSignalRef.current = true;
    try {
      return run();
    } finally {
      suppressDraftEditSignalRef.current = false;
    }
  }, []);

  // Every user-authored value mutation — including edits made while the
  // surface was already dirty, when no dirty transition fires — must retire
  // any exact-request save retry captured before the edit (see the shell
  // controller).
  //
  // Event-filtering semantics (verified against RHF 7.71.2 internals):
  // - Registered-input changes publish {name: "<leaf.path>", type: "change",
  //   values} → counts; blur-only events publish no values payload.
  // - Programmatic user actions (list editors, "use story" fills) publish
  //   {name, values} plus form-state keys → counts.
  // - Each useFieldArray effect publishes a bare {name: <arrayRoot>, values}
  //   whenever RHF resyncs array state: on mount, after every canonical
  //   reseed (resets update the array subject), and after structural row
  //   operations. Those emissions carry no user keystroke behind them on the
  //   reseed paths and arrive asynchronously (outside any suppression
  //   window), so exact array-root names are filtered out. Genuine edits
  //   inside rows carry deeper leaf names ("projects.0.title"), which never
  //   equal a root.
  // - reset()/unregister() publish values with no name at all → filtered.
  useEffect(() => {
    const unsubscribeProfile = profileForm.watch((_values, info) => {
      if (
        suppressDraftEditSignalRef.current ||
        typeof info.name !== "string" ||
        FIELD_ARRAY_ROOT_NAMES.has(info.name)
      ) {
        return;
      }
      input.onDraftEdited?.();
    });
    const unsubscribePreferences = preferencesForm.watch((_values, info) => {
      if (
        suppressDraftEditSignalRef.current ||
        typeof info.name !== "string" ||
        FIELD_ARRAY_ROOT_NAMES.has(info.name)
      ) {
        return;
      }
      input.onDraftEdited?.();
    });

    return () => {
      unsubscribeProfile.unsubscribe();
      unsubscribePreferences.unsubscribe();
    };
  }, [input.onDraftEdited, preferencesForm, profileForm]);

  const experienceArray = useFieldArray({
    control: profileForm.control,
    name: "records.experiences",
    keyName: "fieldKey",
  });
  const educationArray = useFieldArray({
    control: profileForm.control,
    name: "records.education",
    keyName: "fieldKey",
  });
  const certificationArray = useFieldArray({
    control: profileForm.control,
    name: "records.certifications",
    keyName: "fieldKey",
  });
  const projectArray = useFieldArray({
    control: profileForm.control,
    name: "projects",
    keyName: "fieldKey",
  });
  const linkArray = useFieldArray({
    control: profileForm.control,
    name: "links",
    keyName: "fieldKey",
  });
  const languageArray = useFieldArray({
    control: profileForm.control,
    name: "languages",
    keyName: "fieldKey",
  });
  const proofBankArray = useFieldArray({
    control: profileForm.control,
    name: "proofBank",
    keyName: "fieldKey",
  });
  const [
    identityValues,
    summaryValues,
    narrativeValues,
    skillGroupValues,
    profileSkillValues,
    eligibilityValues,
    applicationIdentityValues,
    experienceValues,
    educationValues,
    certificationValues,
    projectValues,
    linkValues,
    languageValues,
    proofBankValues,
  ] = useWatch({
    control: profileForm.control,
    name: [
      "identity",
      "summary",
      "narrative",
      "skillGroups",
      "profileSkills",
      "eligibility",
      "applicationIdentity",
      "records.experiences",
      "records.education",
      "records.certifications",
      "projects",
      "links",
      "languages",
      "proofBank",
    ],
  });
  const [
    targetRoles,
    jobFamilies,
    seniorityLevels,
    employmentTypes,
    locations,
    excludedLocations,
    targetIndustries,
    targetCompanyStages,
    companyWhitelist,
    companyBlacklist,
    workModes,
    tailoringMode,
    minimumSalaryUsd,
    targetSalaryUsd,
    salaryCurrency,
    compensationInterval,
    discoveryTargets,
  ] = useWatch({
    control: preferencesForm.control,
    name: [
      "targetRoles",
      "jobFamilies",
      "seniorityLevels",
      "employmentTypes",
      "locations",
      "excludedLocations",
      "targetIndustries",
      "targetCompanyStages",
      "companyWhitelist",
      "companyBlacklist",
      "workModes",
      "tailoringMode",
      "minimumSalaryUsd",
      "targetSalaryUsd",
      "salaryCurrency",
      "compensationInterval",
      "discoveryTargets",
    ],
  });
  const draftProfileResult = useMemo(
    // Use the same payload as Save: untouched imported values stay canonical.
    // A normalized editor round trip can differ even when nothing needs saving.
    () =>
      buildCanonicalAwareProfilePayload({
        draftValues: profileForm.getValues(),
        dirtyFields: profileForm.formState.dirtyFields,
        latestResumeImportReviewCandidates:
          input.latestResumeImportReviewCandidates,
        profile: currentProfileBaseline,
      }),
    [
      applicationIdentityValues,
      certificationValues,
      currentProfileBaseline,
      educationValues,
      eligibilityValues,
      experienceValues,
      identityValues,
      input.latestResumeImportReviewCandidates,
      languageValues,
      linkValues,
      narrativeValues,
      profileForm,
      profileForm.formState.dirtyFields,
      profileSkillValues,
      proofBankValues,
      projectValues,
      skillGroupValues,
      summaryValues,
    ],
  );
  // An untouched form saves the preferences it was given; building and
  // validating the payload from ~900 job sources cost every Profile visit
  // about 45 ms for nothing.
  const preferencesFormDirty = preferencesForm.formState.isDirty;
  const draftSearchPreferencesResult = useMemo(
    () =>
      preferencesFormDirty
        ? buildSearchPreferencesPayload(
            currentSearchPreferencesBaseline,
            preferencesForm.getValues(),
          )
        : { payload: currentSearchPreferencesBaseline },
    [
      preferencesFormDirty,
      companyBlacklist,
      companyWhitelist,
      compensationInterval,
      currentSearchPreferencesBaseline,
      discoveryTargets,
      employmentTypes,
      excludedLocations,
      jobFamilies,
      locations,
      minimumSalaryUsd,
      preferencesForm,
      salaryCurrency,
      seniorityLevels,
      tailoringMode,
      targetCompanyStages,
      targetIndustries,
      targetRoles,
      targetSalaryUsd,
      workModes,
    ],
  );

  useEffect(() => {
    const incomingProfileFingerprint = buildOrderedContentFingerprint(
      input.profile,
    );
    const incomingCandidatesFingerprint = buildOrderedContentFingerprint(
      input.latestResumeImportReviewCandidates,
    );
    const profileChangedSinceSeen =
      incomingProfileFingerprint !== seenProfileContentFingerprintRef.current;
    const candidatesChangedSinceSeen =
      incomingCandidatesFingerprint !==
      seenReviewCandidatesContentFingerprintRef.current;
    // Own-save echo detection runs first, even when canonical content
    // changed. Screens build their save payload against the newest canonical
    // they have seen, so the echo is matched against both the loaded baseline
    // and that pending canonical before anything else decides.
    // Only an edited form can be echoing its own save, so an untouched one
    // builds and validates no payloads here.
    const draftValues = profileForm.getValues();
    const isEchoOfSavedDraft = () => {
      const echoFingerprints = new Set(
        [latestProfileRef.current, pendingCanonicalProfileRef.current]
          .map((profile) => buildProfilePayload(profile, draftValues).payload)
          .filter((payload) => payload !== undefined)
          .map((payload) => buildOrderedContentFingerprint(payload)),
      );
      return (
        echoFingerprints.has(incomingProfileFingerprint) ||
        buildOrderedContentFingerprint(
          createProfileEditorValues(
            input.profile,
            input.latestResumeImportReviewCandidates,
          ),
        ) === buildOrderedContentFingerprint(draftValues)
      );
    };
    const isSavedProfileDraftEcho =
      profileForm.formState.isDirty && isEchoOfSavedDraft();

    // Seen/pending trackers advance on every path; loaded fingerprints and
    // the save baseline only advance when a form actually adopts content.
    seenProfileContentFingerprintRef.current = incomingProfileFingerprint;
    seenReviewCandidatesContentFingerprintRef.current =
      incomingCandidatesFingerprint;
    pendingCanonicalProfileRef.current = input.profile;

    if (isSavedProfileDraftEcho) {
      latestProfileRef.current = input.profile;
      loadedProfileContentFingerprintRef.current = incomingProfileFingerprint;
      loadedReviewCandidatesContentFingerprintRef.current =
        incomingCandidatesFingerprint;
      runWithoutDraftEditSignal(() =>
        profileForm.reset(
          createProfileEditorValues(
            input.profile,
            input.latestResumeImportReviewCandidates,
          ),
          { keepValues: true },
        ),
      );
      // Incomplete added rows are omitted by the save payload. They are still
      // the person's draft and must survive the response to that save.
      const canonicalLanguageIds = new Set(
        createProfileEditorValues(
          input.profile,
          input.latestResumeImportReviewCandidates,
        ).languages.map((row) => row.id),
      );
      if (
        draftValues.languages.some((row) => !canonicalLanguageIds.has(row.id))
      ) {
        runWithoutDraftEditSignal(() =>
          languageArray.replace(draftValues.languages),
        );
      }
      applyBackgroundConflictSurface("profile", false);
      setValidationMessage(null);
      setBackgroundMergeNotice(
        resolvedBackgroundMergeNotice(
          backgroundConflictSurfacesRef.current.preferences,
          null,
        ),
      );
      return;
    }

    if (!profileChangedSinceSeen && !candidatesChangedSinceSeen) {
      return;
    }

    if (!profileForm.formState.isDirty) {
      latestProfileRef.current = input.profile;
      loadedProfileContentFingerprintRef.current = incomingProfileFingerprint;
      loadedReviewCandidatesContentFingerprintRef.current =
        incomingCandidatesFingerprint;
      runWithoutDraftEditSignal(() =>
        profileForm.reset(
          createProfileEditorValues(
            input.profile,
            input.latestResumeImportReviewCandidates,
          ),
        ),
      );
      applyBackgroundConflictSurface("profile", false);
      setValidationMessage(null);
      setBackgroundMergeNotice(
        resolvedBackgroundMergeNotice(
          backgroundConflictSurfacesRef.current.preferences,
          null,
        ),
      );
      return;
    }

    // Meaningful external update while dirty: merge the fresh canonical
    // editor values under the kept dirty edits.
    const mergeOutcome = mergeDirtyEditorValues(
      createProfileEditorValues(
        input.profile,
        input.latestResumeImportReviewCandidates,
      ),
      draftValues,
      profileForm.formState.dirtyFields,
    );

    if (mergeOutcome.status === "conflict") {
      // Atomic abort: keep every local value, keep the previous baseline for
      // stale-save protection, and leave dirty guards untouched. The surface
      // is marked conflicted so the discard-and-reload affordance appears and
      // a later Save overwrites only with explicit intent.
      applyBackgroundConflictSurface("profile", true);
      setBackgroundMergeNotice(backgroundConflictNoticeMessage);
      return;
    }

    latestProfileRef.current = input.profile;
    loadedProfileContentFingerprintRef.current = incomingProfileFingerprint;
    loadedReviewCandidatesContentFingerprintRef.current =
      incomingCandidatesFingerprint;
    runWithoutDraftEditSignal(() => {
      if (
        buildOrderedContentFingerprint(mergeOutcome.value) ===
        buildOrderedContentFingerprint(draftValues)
      ) {
        profileForm.reset(
          createProfileEditorValues(
            input.profile,
            input.latestResumeImportReviewCandidates,
          ),
          {
            keepValues: true,
            keepDirty: true,
          },
        );
      } else
        profileForm.reset(mergeOutcome.value as ProfileEditorValues, {
          keepDirty: true,
        });
    });
    applyBackgroundConflictSurface("profile", false);
    setValidationMessage(null);
    setBackgroundMergeNotice(
      resolvedBackgroundMergeNotice(
        backgroundConflictSurfacesRef.current.preferences,
        backgroundMergedNoticeMessage,
      ),
    );
  }, [
    applyBackgroundConflictSurface,
    input.latestResumeImportReviewCandidates,
    input.profile,
    languageArray.replace,
    profileForm,
  ]);

  useEffect(() => {
    const incomingPreferencesFingerprint = buildOrderedContentFingerprint(
      input.searchPreferences,
    );
    const preferencesChangedSinceSeen =
      incomingPreferencesFingerprint !==
      seenSearchPreferencesContentFingerprintRef.current;
    // Only an edited form can be echoing its own save.
    const draftPreferencesValues = preferencesForm.getValues();
    const isSavedPreferencesDraftEcho =
      preferencesForm.formState.isDirty &&
      [
        latestSearchPreferencesRef.current,
        pendingCanonicalSearchPreferencesRef.current,
      ]
        .map(
          (preferences) =>
            buildSearchPreferencesPayload(preferences, draftPreferencesValues)
              .payload,
        )
        .some(
          (payload) =>
            payload !== undefined &&
            buildOrderedContentFingerprint(payload) ===
              incomingPreferencesFingerprint,
        );

    seenSearchPreferencesContentFingerprintRef.current =
      incomingPreferencesFingerprint;
    pendingCanonicalSearchPreferencesRef.current = input.searchPreferences;

    if (isSavedPreferencesDraftEcho) {
      latestSearchPreferencesRef.current = input.searchPreferences;
      loadedSearchPreferencesContentFingerprintRef.current =
        incomingPreferencesFingerprint;
      runWithoutDraftEditSignal(() =>
        preferencesForm.reset(
          createSearchPreferencesEditorValues(input.searchPreferences),
          { keepValues: true },
        ),
      );
      applyBackgroundConflictSurface("preferences", false);
      setValidationMessage(null);
      setBackgroundMergeNotice(
        resolvedBackgroundMergeNotice(
          backgroundConflictSurfacesRef.current.profile,
          null,
        ),
      );
      return;
    }

    if (!preferencesChangedSinceSeen) {
      return;
    }

    if (!preferencesForm.formState.isDirty) {
      latestSearchPreferencesRef.current = input.searchPreferences;
      loadedSearchPreferencesContentFingerprintRef.current =
        incomingPreferencesFingerprint;
      runWithoutDraftEditSignal(() =>
        preferencesForm.reset(
          createSearchPreferencesEditorValues(input.searchPreferences),
        ),
      );
      applyBackgroundConflictSurface("preferences", false);
      setValidationMessage(null);
      setBackgroundMergeNotice(
        resolvedBackgroundMergeNotice(
          backgroundConflictSurfacesRef.current.profile,
          null,
        ),
      );
      return;
    }

    const preferencesMergeOutcome = mergeDirtyEditorValues(
      createSearchPreferencesEditorValues(input.searchPreferences),
      draftPreferencesValues,
      preferencesForm.formState.dirtyFields,
    );

    if (preferencesMergeOutcome.status === "conflict") {
      applyBackgroundConflictSurface("preferences", true);
      setBackgroundMergeNotice(backgroundConflictNoticeMessage);
      return;
    }

    latestSearchPreferencesRef.current = input.searchPreferences;
    loadedSearchPreferencesContentFingerprintRef.current =
      incomingPreferencesFingerprint;
    runWithoutDraftEditSignal(() =>
      preferencesForm.reset(
        preferencesMergeOutcome.value as SearchPreferencesEditorValues,
        { keepDirty: true },
      ),
    );
    applyBackgroundConflictSurface("preferences", false);
    setValidationMessage(null);
    setBackgroundMergeNotice(
      resolvedBackgroundMergeNotice(
        backgroundConflictSurfacesRef.current.profile,
        backgroundMergedNoticeMessage,
      ),
    );
  }, [
    applyBackgroundConflictSurface,
    input.searchPreferences,
    preferencesForm,
  ]);

  // Each check fingerprints a whole profile or every job source; they change
  // only when the draft or its baseline does, so they are not redone per render.
  const profileDraftDiffers = useMemo(
    () =>
      hasProfileDraftChanges(
        currentProfileBaseline,
        draftProfileResult.payload,
      ),
    [currentProfileBaseline, draftProfileResult.payload],
  );
  const preferencesDraftDiffers = useMemo(
    () =>
      hasSearchPreferencesDraftChanges(
        currentSearchPreferencesBaseline,
        draftSearchPreferencesResult.payload,
      ),
    [currentSearchPreferencesBaseline, draftSearchPreferencesResult.payload],
  );
  const hasUnsavedChanges =
    profileForm.formState.isDirty ||
    preferencesForm.formState.isDirty ||
    profileDraftDiffers ||
    preferencesDraftDiffers;
  const hasUserDraftChanges =
    profileForm.formState.isDirty || preferencesForm.formState.isDirty;
  // One signal per user-invoked structural mutation; the wrapper preserves
  // the full field-array shape (fields, registered methods) screens expect.
  const wrapUserFieldArray = <TFieldArray>(
    fieldArray: TFieldArray,
  ): TFieldArray =>
    wrapFieldArrayStructuralMutators(fieldArray, () => {
      if (!suppressDraftEditSignalRef.current) {
        input.onDraftEdited?.();
      }
    });
  const backgroundArrays: ProfileBackgroundArrays = {
    certificationArray: wrapUserFieldArray(certificationArray),
    educationArray: wrapUserFieldArray(educationArray),
    languageArray: wrapUserFieldArray(languageArray),
    linkArray: wrapUserFieldArray(linkArray),
    proofBankArray: wrapUserFieldArray(proofBankArray),
    projectArray: wrapUserFieldArray(projectArray),
  };
  const siteCounts = useSitePage({ limit: 1 }).counts;
  const { overviewProfile, sections } = useMemo(
    () =>
      buildProfileScreenViewModel({
        applicationIdentityValues,
        certificationValues,
        companyBlacklist,
        companyWhitelist,
        siteCounts,
        educationValues,
        eligibilityValues,
        employmentTypes,
        excludedLocations,
        experienceValues,
        identityValues,
        jobFamilies,
        languageValues,
        linkValues,
        locations,
        minimumSalaryUsd,
        narrativeValues,
        profile: currentProfileBaseline,
        profileSkillValues,
        proofBankValues,
        projectValues,
        seniorityLevels,
        skillGroupValues,
        summaryValues,
        tailoringMode,
        targetCompanyStages,
        targetIndustries,
        targetRoles,
        targetSalaryUsd,
        workModes,
      }),
    [
      applicationIdentityValues,
      certificationValues,
      companyBlacklist,
      companyWhitelist,
      siteCounts,
      educationValues,
      eligibilityValues,
      employmentTypes,
      excludedLocations,
      experienceValues,
      identityValues,
      currentProfileBaseline,
      jobFamilies,
      languageValues,
      linkValues,
      locations,
      minimumSalaryUsd,
      narrativeValues,
      profileSkillValues,
      proofBankValues,
      projectValues,
      seniorityLevels,
      skillGroupValues,
      summaryValues,
      tailoringMode,
      targetCompanyStages,
      targetIndustries,
      targetRoles,
      targetSalaryUsd,
      workModes,
    ],
  );

  // Explicit recovery for an unresolved background conflict: drop every
  // editor-owned draft value and reseed both forms from the newest canonical
  // props, advancing baselines and loaded fingerprints exactly like the
  // clean-adoption path so later identical snapshots cannot re-trigger
  // handling. Saving instead remains possible and now means a deliberate
  // overwrite stated in the conflict notice.
  function discardEditsAndReloadCanonical() {
    runWithoutDraftEditSignal(() =>
      profileForm.reset(
        createProfileEditorValues(
          input.profile,
          input.latestResumeImportReviewCandidates,
        ),
      ),
    );
    latestProfileRef.current = input.profile;
    loadedProfileContentFingerprintRef.current = buildOrderedContentFingerprint(
      input.profile,
    );
    loadedReviewCandidatesContentFingerprintRef.current =
      buildOrderedContentFingerprint(input.latestResumeImportReviewCandidates);

    runWithoutDraftEditSignal(() =>
      preferencesForm.reset(
        createSearchPreferencesEditorValues(input.searchPreferences),
      ),
    );
    latestSearchPreferencesRef.current = input.searchPreferences;
    loadedSearchPreferencesContentFingerprintRef.current =
      buildOrderedContentFingerprint(input.searchPreferences);

    applyBackgroundConflictSurface("profile", false);
    applyBackgroundConflictSurface("preferences", false);
    setValidationMessage(null);
    setBackgroundMergeNotice(null);
  }

  const hasBackgroundConflict =
    backgroundConflictSurfaces.preferences ||
    backgroundConflictSurfaces.profile;

  return {
    backgroundArrays,
    backgroundMergeNotice,
    discardEditsAndReloadCanonical,
    draftProfileResult,
    draftDiffers: profileDraftDiffers || preferencesDraftDiffers,
    draftSearchPreferencesResult,
    experienceArray: wrapUserFieldArray(experienceArray),
    hasBackgroundConflict,
    hasUnsavedChanges,
    hasUserDraftChanges,
    overviewProfile,
    preferencesForm,
    profileForm,
    sections,
    setValidationMessage,
    validationMessage,
  };
}
