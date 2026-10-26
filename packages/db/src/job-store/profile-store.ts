import {
  invalidateProfileResumes,
  followPrimaryContact,
} from "./profile-effects";
import {
  createFreshStartCandidateProfile,
  ProfileFieldsSchema,
  ProfileListsSchema,
  PatchProfileInputSchema,
  StoredProfileSchema,
  ProfileOverviewSchema,
  ProfileRecordCollectionSchema,
  ProfileRecordSchema,
  ResumeSourceDocumentSchema,
  type PatchProfileInput,
  type StoredProfile,
  type ProfileLists,
  type ResumeSourceDocument,
  type ProfileOverview,
  type CandidateWorkEligibility,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";
import {
  createProfileRecords,
  PROFILE_RECORDS_SCHEMA,
} from "./profile-records";
import {
  createScalarValues,
  scalarSchema,
  flatten,
  inflate,
  createProfileItems,
  PROFILE_ITEMS_SCHEMA,
  flattenLists,
  type ScalarTable,
} from "./profile-values";

const profileFields = Object.keys(ProfileFieldsSchema.shape);
const PROFILE_TABLE: ScalarTable = {
  name: "profile",
  fields: profileFields,
  booleans: [
    "workEligibility.requiresVisaSponsorship",
    "workEligibility.willingToRelocate",
    "workEligibility.willingToTravel",
    "workEligibility.remoteEligible",
  ],
  numbers: ["yearsExperience", "workEligibility.noticePeriodDays"],
  optional: profileFields.filter((key) => {
    const schema =
      ProfileFieldsSchema.shape[key as keyof typeof ProfileFieldsSchema.shape];
    return schema.isOptional() && !schema.isNullable();
  }),
};
const sourceFields = [
  "sourceId",
  "fileName",
  "uploadedAt",
  "storagePath",
  "sha256",
  "textUpdatedAt",
  "extractionStatus",
  "lastAnalyzedAt",
  "analysisProviderKind",
  "analysisProviderLabel",
  "sourceIdentity.fullName",
  "sourceIdentity.email",
  "ownership.acknowledgedSourceFullName",
  "ownership.acknowledgedSourceEmail",
  "ownership.acknowledgedAt",
];
const RESUME_TABLE: ScalarTable = {
  name: "profile_resume_source",
  fields: sourceFields,
  booleans: [],
  numbers: [],
};
export const PROFILE_SCHEMA = [
  scalarSchema(PROFILE_TABLE),
  scalarSchema(RESUME_TABLE),
  PROFILE_ITEMS_SCHEMA,
  PROFILE_RECORDS_SCHEMA,
  `
 CREATE TABLE IF NOT EXISTS profile_resume_text(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT);
 CREATE TABLE IF NOT EXISTS profile_identity(id INTEGER PRIMARY KEY CHECK(id=1),profile_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS profile_work_permissions(country TEXT NOT NULL,conditions TEXT NOT NULL,requires_future_sponsorship INTEGER,position INTEGER NOT NULL,PRIMARY KEY(country,conditions));
 CREATE INDEX IF NOT EXISTS profile_work_permissions_country ON profile_work_permissions(country,position);
 CREATE TABLE IF NOT EXISTS profile_revision(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 1);
 INSERT OR IGNORE INTO profile_revision(id,version) VALUES(1,1);
 `,
].join("\n");

export function createProfileStore(store: JobStore) {
  const empty = StoredProfileSchema.parse(createFreshStartCandidateProfile()),
    values = createScalarValues(
      store,
      PROFILE_TABLE,
      flatten(empty, profileFields),
    ),
    items = createProfileItems(store),
    records = createProfileRecords(store);
  const source = createScalarValues(
    store,
    RESUME_TABLE,
    flatten(
      { ...empty.baseResume, sourceId: empty.baseResume.id },
      sourceFields,
    ),
  );
  store.transaction(() =>
    store
      .sql("INSERT OR IGNORE INTO profile_identity(id,profile_id) VALUES (1,?)")
      .run(empty.id),
  );
  const profileId = () =>
    (
      store
        .sql("SELECT profile_id AS id FROM profile_identity WHERE id=1")
        .get() as { id: string }
    ).id;
  const lists = (): ProfileLists =>
    ProfileListsSchema.parse(
      Object.fromEntries(
        Object.keys(ProfileListsSchema.shape).map((field) => [
          field,
          items.values("profile", "1", field),
        ]),
      ),
    );
  const fields = () => ProfileFieldsSchema.parse(values.read());
  const permissions = (): NonNullable<
    CandidateWorkEligibility["limitedWorkPermissions"]
  > => {
    const rows = store
      .sql(
        "SELECT country,conditions,requires_future_sponsorship AS future FROM profile_work_permissions ORDER BY position,country,conditions",
      )
      .all() as {
      country: string;
      conditions: string;
      future: number | null;
    }[];
    return rows.map((row) => ({
      country: row.country,
      conditions: row.conditions,
      requiresFutureSponsorship:
        row.future === null ? null : Boolean(row.future),
    }));
  };
  const readSource = (): ResumeSourceDocument => {
    const data = inflate(source.read());
    const identity = data.sourceIdentity as
      | { fullName: string | null; email: string | null }
      | undefined;
    if (!identity?.fullName && !identity?.email) delete data.sourceIdentity;
    return ResumeSourceDocumentSchema.parse({
      ...data,
      textContent:
        (
          store.sql("SELECT body FROM profile_resume_text WHERE id=1").get() as
            | { body: string | null }
            | undefined
        )?.body ?? null,
      id: data.sourceId,
      analysisWarnings: items.values("resume", "1", "analysisWarnings"),
    });
  };
  const overview = (): ProfileOverview => {
    // The list/edit surface never loads the full imported resume text or file path.
    const metadata = source.read();
    return ProfileOverviewSchema.parse({
      hasResumeText: Boolean(
        (
          store
            .sql(
              "SELECT body IS NOT NULL AS present FROM profile_resume_text WHERE id=1",
            )
            .get() as { present: number } | undefined
        )?.present,
      ),
      hasSavedResumeFile: Boolean(metadata.storagePath && metadata.sha256),
      resumeIdentityOwnership: metadata["ownership.acknowledgedAt"]
        ? {
            acknowledgedAt: metadata["ownership.acknowledgedAt"],
            acknowledgedSourceFullName:
              metadata["ownership.acknowledgedSourceFullName"],
            acknowledgedSourceEmail:
              metadata["ownership.acknowledgedSourceEmail"],
          }
        : null,
      id: profileId(),
      fields: fields(),
      lists: lists(),
      counts: records.counts(),
      experienceRequired: records.experienceRequired(),
      resume: {
        ...inflate(metadata),
        id: metadata.sourceId,
        analysisWarnings: items.values("resume", "1", "analysisWarnings"),
      },
      limitedWorkPermissions: permissions(),
    });
  };
  const api = {
    created: values.created,
    overview,
    records,
    read(): StoredProfile {
      const data = inflate({ ...fields(), ...lists() });
      for (const kind of ProfileRecordCollectionSchema.options)
        data[kind] = records.all(kind).map((row) => row.record);
      const sourceData = source.read(
          sourceFields.filter((field) => field.startsWith("ownership.")),
        ),
        ack = sourceData["ownership.acknowledgedAt"];
      return StoredProfileSchema.parse({
        ...data,
        id: profileId(),
        baseResume: readSource(),
        workEligibility: {
          ...(data.workEligibility as Record<string, unknown>),
          ...(permissions().length
            ? { limitedWorkPermissions: permissions() }
            : {}),
        },
        resumeIdentityOwnership: ack
          ? {
              acknowledgedAt: ack,
              acknowledgedSourceFullName:
                sourceData["ownership.acknowledgedSourceFullName"],
              acknowledgedSourceEmail:
                sourceData["ownership.acknowledgedSourceEmail"],
            }
          : null,
      });
    },
    /** Imports and AI edits reconcile their accepted facts; unchanged rows are untouched. */
    replace(input: StoredProfile): void {
      const next = StoredProfileSchema.parse(input);
      store.transaction(() => {
        api.patch({
          fields: flatten(next, profileFields),
          lists: flattenLists(next, Object.keys(ProfileListsSchema.shape)),
        });
        for (const collection of ProfileRecordCollectionSchema.options) {
          const incoming = new Set(next[collection].map((row) => row.id));
          for (const row of records.all(collection))
            if (!incoming.has(row.record.id))
              records.remove(collection, row.record.id);
          for (const record of next[collection])
            records.upsert(ProfileRecordSchema.parse({ collection, record }));
          records.reorder(
            collection,
            next[collection].map((row) => row.id),
          );
        }
        api.setResumeSource(next.baseResume, next.resumeIdentityOwnership);
        api.setWorkPermissions(
          next.workEligibility.limitedWorkPermissions ?? [],
        );
        const changed = store
          .sql(
            "UPDATE profile_identity SET profile_id=? WHERE id=1 AND profile_id<>?",
          )
          .run(next.id, next.id).changes;
        if (changed)
          store.notify({
            cause: "profile",
            stages: [],
            ids: [],
            searchId: null,
          });
      });
    },
    patch(input: PatchProfileInput): ProfileOverview {
      const patch = PatchProfileInputSchema.parse(input);
      return store.transaction(() => {
        const before = values.read([
          "email",
          "phone",
          "applicationIdentity.preferredEmail",
          "applicationIdentity.preferredPhone",
        ]);
        const nextFields = { ...patch.fields };
        for (const [primary, preferred] of [
          ["email", "applicationIdentity.preferredEmail"],
          ["phone", "applicationIdentity.preferredPhone"],
        ] as const) {
          if (Object.hasOwn(nextFields, primary))
            nextFields[preferred] = followPrimaryContact({
              before: before[primary],
              after: nextFields[primary],
              preferred: before[preferred],
              nextPreferred: Object.hasOwn(nextFields, preferred)
                ? nextFields[preferred]
                : before[preferred],
              phone: primary === "phone",
            }) as string | null;
        }
        const previousFields = values.read(Object.keys(nextFields));
        let resumeChanged = Object.entries(nextFields).some(
          ([key, value]) =>
            value !== undefined &&
            (value ?? null) !== (previousFields[key] ?? null) &&
            !key.startsWith("workEligibility.") &&
            !key.startsWith("applicationIdentity."),
        );
        let changed = values.patch(nextFields, patch.expected);
        for (const [field, value] of Object.entries(patch.lists)) {
          if (value === undefined) continue;
          const touched = items.patch("profile", "1", field, value);
          changed = touched || changed;
          resumeChanged =
            resumeChanged || (touched && !field.startsWith("workEligibility."));
        }
        if (resumeChanged) invalidateProfileResumes(store);
        if (changed)
          store.notify({
            cause: "profile",
            stages: [],
            ids: [],
            searchId: null,
          });
        return overview();
      });
    },
    /** Accepted import facts only; file ownership stays at the main-process import boundary. */
    setResumeSource(
      document: ResumeSourceDocument,
      ownership: StoredProfile["resumeIdentityOwnership"] = null,
    ): void {
      const parsed = ResumeSourceDocumentSchema.parse(document);
      store.transaction(() => {
        const flat = flatten(
          {
            ...parsed,
            sourceId: parsed.id,
            ownership: ownership ?? {
              acknowledgedSourceFullName: null,
              acknowledgedSourceEmail: null,
              acknowledgedAt: null,
            },
          },
          sourceFields,
        );
        const previous = source.read([
          "sourceId",
          "fileName",
          "storagePath",
          "textUpdatedAt",
        ]);
        let changed = source.patch(
          Object.fromEntries(
            Object.entries(flat).map(([key, value]) => [key, value ?? null]),
          ),
        );
        const bodyChanged = store
          .sql(
            "INSERT INTO profile_resume_text(id,body) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body WHERE body IS NOT excluded.body",
          )
          .run(parsed.textContent).changes;
        changed = Boolean(bodyChanged) || changed;
        if (
          bodyChanged ||
          Object.keys(previous).some(
            (key) => previous[key] !== (flat[key] ?? null),
          )
        )
          invalidateProfileResumes(store);
        changed =
          items.patch(
            "resume",
            "1",
            "analysisWarnings",
            parsed.analysisWarnings,
          ) || changed;
        if (changed)
          store.notify({
            cause: "profile",
            stages: [],
            ids: [],
            searchId: null,
          });
      });
    },
    setWorkPermissions(
      input: NonNullable<CandidateWorkEligibility["limitedWorkPermissions"]>,
    ): void {
      store.transaction(() => {
        const current = permissions(),
          key = (item: { country: string; conditions: string }) =>
            JSON.stringify([item.country, item.conditions]),
          next = new Set(input.map(key));
        let changed = false;
        for (const item of current)
          if (!next.has(key(item))) {
            store
              .sql(
                "DELETE FROM profile_work_permissions WHERE country=? AND conditions=?",
              )
              .run(item.country, item.conditions);
            changed = true;
          }
        for (const [position, item] of input.entries()) {
          const result = store
            .sql(
              `INSERT INTO profile_work_permissions(country,conditions,requires_future_sponsorship,position) VALUES (?,?,?,?) ON CONFLICT(country,conditions) DO UPDATE SET requires_future_sponsorship=excluded.requires_future_sponsorship,position=excluded.position WHERE requires_future_sponsorship IS NOT excluded.requires_future_sponsorship OR position<>excluded.position`,
            )
            .run(
              item.country,
              item.conditions,
              item.requiresFutureSponsorship === null
                ? null
                : Number(item.requiresFutureSponsorship),
              position,
            );
          changed = Boolean(result.changes) || changed;
        }
        if (changed)
          store.notify({
            cause: "profile",
            stages: [],
            ids: [],
            searchId: null,
          });
      });
    },
  };
  return api;
}
export type ProfileStore = ReturnType<typeof createProfileStore>;
