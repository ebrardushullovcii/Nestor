import {
  ProfileFieldsSchema,
  ProfileListsSchema,
  GoalFieldsSchema,
  GoalListsSchema,
  ProfileRecordSchemas,
  ProfileRecordSchema,
  CommitProfileEditsInputSchema,
  type StoredProfile,
  type ProfileOverview,
  type ProfileRecord,
  type ProfileRecordCollection,
  type ProfileEditBatch,
  type JobSearchPreferences,
} from "@nestor/contracts";

function leaf(value: unknown, path: string): unknown {
  for (const part of path.split("."))
    value =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[part]
        : undefined;
  return value;
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
/** Compare only the fields/record pages actually read by this editor, not a workspace snapshot. */
export function profileEdits(input: {
  overview: ProfileOverview;
  records: Partial<Record<ProfileRecordCollection, readonly ProfileRecord[]>>;
  goals: JobSearchPreferences;
  beforeProfile?: StoredProfile;
  beforeGoals?: JobSearchPreferences;
  nextProfile: StoredProfile;
  nextGoals: JobSearchPreferences;
}): ProfileEditBatch {
  const changes = (
    shape: Record<string, { isNullable(): boolean }>,
    before: (key: string) => unknown,
    after: unknown,
  ) =>
    Object.fromEntries(
      Object.keys(shape).flatMap((key) => {
        const normalize = (value: unknown) =>
          value === undefined && shape[key]!.isNullable() ? null : value;
        const next = normalize(leaf(after, key));
        return same(normalize(before(key)), next) ? [] : [[key, next]];
      }),
    );
  const fields = ProfileFieldsSchema.parse(
    changes(
      ProfileFieldsSchema.shape,
      (key) =>
        input.beforeProfile
          ? leaf(input.beforeProfile, key)
          : input.overview.fields[key as keyof typeof input.overview.fields],
      input.nextProfile,
    ),
  );
  const lists = ProfileListsSchema.parse(
    changes(
      ProfileListsSchema.shape,
      (key) =>
        input.beforeProfile
          ? leaf(input.beforeProfile, key)
          : input.overview.lists[key as keyof typeof input.overview.lists],
      input.nextProfile,
    ),
  );
  const goalFields = GoalFieldsSchema.parse(
    changes(
      GoalFieldsSchema.shape,
      (key) => leaf(input.beforeGoals ?? input.goals, key),
      input.nextGoals,
    ),
  );
  const goalLists = GoalListsSchema.parse(
    changes(
      GoalListsSchema.shape,
      (key) => leaf(input.beforeGoals ?? input.goals, key),
      input.nextGoals,
    ),
  );
  const upsert: ProfileRecord[] = [],
    remove: { collection: ProfileRecordCollection; id: string }[] = [];
  for (const [collection, before] of Object.entries(input.records) as [
    ProfileRecordCollection,
    readonly ProfileRecord[],
  ][]) {
    const previous = new Map(
      (input.beforeProfile
        ? input.beforeProfile[collection]
        : before.map((row) => row.record)
      ).map((record) => [record.id, record]),
    );
    const next = input.nextProfile[collection];
    for (const value of next) {
      const record = ProfileRecordSchemas[collection].parse(value);
      if (!same(previous.get(record.id), record))
        upsert.push(ProfileRecordSchema.parse({ collection, record }));
      previous.delete(record.id);
    }
    for (const id of previous.keys()) remove.push({ collection, id });
  }
  const beforePermissions = input.beforeProfile
    ? input.beforeProfile.workEligibility.limitedWorkPermissions
    : input.overview.limitedWorkPermissions;
  return CommitProfileEditsInputSchema.parse({
    resumeIdentityChoice: !same(
      (input.beforeProfile
        ? input.beforeProfile.resumeIdentityOwnership
        : input.overview.resumeIdentityOwnership) ?? null,
      input.nextProfile.resumeIdentityOwnership ?? null,
    )
      ? input.nextProfile.resumeIdentityOwnership
        ? "profile_name"
        : "resume_name"
      : undefined,
    profile: {
      fields,
      lists,
      expectedLists: Object.fromEntries(
        Object.keys(lists).map((key) => [
          key,
          input.beforeProfile
            ? (leaf(input.beforeProfile, key) ?? [])
            : (input.overview.lists[key as keyof typeof input.overview.lists] ??
              []),
        ]),
      ),
      expected: ProfileFieldsSchema.parse(
        Object.fromEntries(
          Object.keys(fields).map((key) => [
            key,
            input.beforeProfile
              ? leaf(input.beforeProfile, key)
              : input.overview.fields[
                  key as keyof typeof input.overview.fields
                ],
          ]),
        ),
      ),
    },
    goals: {
      fields: goalFields,
      lists: goalLists,
      expected: Object.fromEntries(
        Object.keys(goalFields).map((key) => [
          key,
          leaf(input.beforeGoals ?? input.goals, key),
        ]),
      ),
      expectedLists: Object.fromEntries(
        Object.keys(goalLists).map((key) => [
          key,
          leaf(input.beforeGoals ?? input.goals, key) ?? [],
        ]),
      ),
    },
    upsert,
    remove,
    expectedRecords: [
      ...upsert.map((row) => ({
        collection: row.collection,
        id: row.record.id,
      })),
      ...remove,
    ].map(({ collection, id }) => {
      const value = input.beforeProfile
        ? input.beforeProfile[collection].find((record) => record.id === id)
        : input.records[collection]?.find((row) => row.record.id === id)
            ?.record;
      return {
        collection,
        id,
        value: value ? { collection, record: value } : null,
      };
    }),
    expectedWorkPermissions: !same(
      beforePermissions,
      input.nextProfile.workEligibility.limitedWorkPermissions,
    )
      ? beforePermissions
      : undefined,
    workPermissions: !same(
      beforePermissions,
      input.nextProfile.workEligibility.limitedWorkPermissions,
    )
      ? input.nextProfile.workEligibility.limitedWorkPermissions
      : undefined,
  });
}
