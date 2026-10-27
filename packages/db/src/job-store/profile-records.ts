import {
  ProfileRecordSchema,
  ProfileRecordQuerySchema,
  type ProfileRecord,
  type ProfileRecordCollection,
  type ProfileRecordQuery,
  type ProfileRecordPage,
} from "@nestor/contracts";
import type { JobStore } from "./job-store";
import {
  column,
  quote,
  encode,
  createProfileItems,
  type Fields,
} from "./profile-values";

interface Definition {
  text: readonly string[];
  bool: readonly string[];
  lists: readonly string[];
}
const definitions = {
  experiences: {
    text: [
      "companyName",
      "companyUrl",
      "title",
      "employmentType",
      "location",
      "startDate",
      "endDate",
      "summary",
      "peopleManagementScope",
      "ownershipScope",
    ],
    bool: ["isCurrent", "isDraft"],
    lists: ["workMode", "achievements", "skills", "domainTags"],
  },
  education: {
    text: [
      "schoolName",
      "degree",
      "fieldOfStudy",
      "location",
      "startDate",
      "endDate",
      "summary",
    ],
    bool: ["isDraft"],
    lists: [],
  },
  certifications: {
    text: ["name", "issuer", "issueDate", "expiryDate", "credentialUrl"],
    bool: ["isDraft"],
    lists: [],
  },
  links: { text: ["label", "url", "kind"], bool: ["isDraft"], lists: [] },
  projects: {
    text: [
      "name",
      "projectType",
      "summary",
      "role",
      "outcome",
      "projectUrl",
      "repositoryUrl",
      "caseStudyUrl",
    ],
    bool: [],
    lists: ["skills"],
  },
  spokenLanguages: {
    text: ["language", "proficiency", "notes"],
    bool: ["interviewPreference"],
    lists: [],
  },
  proofBank: {
    text: ["title", "claim", "heroMetric", "supportingContext"],
    bool: [],
    lists: ["roleFamilies", "projectIds", "linkIds"],
  },
} as const satisfies Record<ProfileRecordCollection, Definition>;
const table = (kind: ProfileRecordCollection) => `profile_${column(kind)}`;
export const PROFILE_RECORDS_SCHEMA = Object.entries(definitions)
  .map(([kind, spec]) => {
    const name = table(kind as ProfileRecordCollection);
    return `CREATE TABLE IF NOT EXISTS ${name}(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,${spec.text
      .map((key) => `${column(key)} TEXT`)
      .concat(spec.bool.map((key) => `${column(key)} INTEGER`))
      .join(",")});
 CREATE INDEX IF NOT EXISTS ${name}_page ON ${name}(seq,id);
 ${spec.text
   .filter((key) =>
     [
       "title",
       "name",
       "companyName",
       "schoolName",
       "language",
       "kind",
     ].includes(key),
   )
   .map(
     (key) =>
       `CREATE INDEX IF NOT EXISTS ${name}_${column(key)} ON ${name}(${column(key)},seq);`,
   )
   .join("\n")}`;
  })
  .join("\n");
export function createProfileRecords(
  store: JobStore,
  withResumeEffects: <T>(write: () => T) => T,
) {
  const items = createProfileItems(store);
  const transaction = <T>(kind: ProfileRecordCollection, write: () => T) =>
    store.transaction(() =>
      kind === "links" ? withResumeEffects(write) : write(),
    );
  const rows = (
    kind: ProfileRecordCollection,
    records: Record<string, unknown>[],
  ): ProfileRecord[] => {
    const spec: Definition = definitions[kind],
      ids = records.map((row) => String(row.id));
    const children = store
      .sql(
        "SELECT owner,field,value FROM profile_items WHERE scope=? AND owner IN (SELECT value FROM json_each(?)) ORDER BY position,id",
      )
      .all(kind, JSON.stringify(ids)) as {
      owner: string;
      field: string;
      value: string;
    }[];
    const lists = new Map<string, string[]>();
    for (const child of children) {
      const key = `${child.owner}\n${child.field}`,
        values = lists.get(key) ?? [];
      values.push(child.value);
      lists.set(key, values);
    }
    return records.map((row) => {
      const record: Record<string, unknown> = { id: row.id };
      for (const field of spec.text) record[field] = row[column(field)];
      for (const field of spec.bool)
        record[field] = Boolean(row[column(field)]);
      for (const field of spec.lists)
        record[field] = lists.get(`${String(row.id)}\n${field}`) ?? [];
      return ProfileRecordSchema.parse({ collection: kind, record });
    });
  };
  const all = (kind: ProfileRecordCollection) =>
    rows(
      kind,
      store.sql(`SELECT * FROM ${table(kind)} ORDER BY seq`).all() as Record<
        string,
        unknown
      >[],
    );
  return {
    all,
    reorder(kind: ProfileRecordCollection, ids: readonly string[]): void {
      const name = table(kind);
      const rows = store
        .sql(`SELECT id,seq FROM ${name} ORDER BY seq`)
        .all() as { id: string; seq: number }[];
      if (
        rows.length !== ids.length ||
        new Set(ids).size !== rows.length ||
        rows.some((row) => !ids.includes(row.id))
      )
        throw new Error(
          "Profile order must name every current record exactly once.",
        );
      const changed = ids.flatMap((id, index) =>
        rows[index]!.id === id ? [] : [{ id, seq: rows[index]!.seq }],
      );
      if (!changed.length) return;
      transaction(kind, () => {
        for (const row of changed)
          store.sql(`UPDATE ${name} SET seq=-seq WHERE id=?`).run(row.id);
        for (const row of changed)
          store.sql(`UPDATE ${name} SET seq=? WHERE id=?`).run(row.seq, row.id);
        invalidateUnapprovedProfileResumes(store);
        store.notify({ cause: "profile", ids: [], stages: [], searchId: null });
      });
    },
    experienceRequired() {
      const result = store
        .sql(
          `SELECT count(*) AS count,
        coalesce(sum((length(trim(coalesce(title,'')))>0)
          +(length(trim(coalesce(company_name,'')))>0)
          +(length(trim(coalesce(start_date,'')))>0)),0) AS filled
        FROM profile_experiences`,
        )
        .get() as { count: number; filled: number };
      return {
        filled: result.filled,
        total: result.count ? result.count * 3 : 1,
      };
    },
    get(kind: ProfileRecordCollection, id: string): ProfileRecord | null {
      const row = store
        .sql(`SELECT * FROM ${table(kind)} WHERE id=?`)
        .get(id) as Record<string, unknown> | undefined;
      return row ? rows(kind, [row])[0]! : null;
    },
    counts() {
      return Object.fromEntries(
        Object.keys(definitions).map((kind) => [
          kind,
          (
            store
              .sql(
                `SELECT count(*) AS n FROM ${table(kind as ProfileRecordCollection)}`,
              )
              .get() as { n: number }
          ).n,
        ]),
      ) as Record<ProfileRecordCollection, number>;
    },
    list(input: ProfileRecordQuery): ProfileRecordPage {
      const query = ProfileRecordQuerySchema.parse(input),
        spec: Definition = definitions[query.collection],
        pattern = `%${query.text.replace(/[\\%_]/gu, "\\$&")}%`,
        args = spec.text.map(() => pattern);
      const where = query.text
        ? `(${spec.text.map((field) => `${column(field)} LIKE ? ESCAPE '\\'`).join(" OR ")})`
        : "1";
      const params = query.text ? args : [],
        name = table(query.collection);
      const total = (
        store
          .sql(`SELECT count(*) AS n FROM ${name} WHERE ${where}`)
          .get(...params) as { n: number }
      ).n;
      const page = store
        .sql(
          `SELECT * FROM ${name} WHERE ${where} AND seq>? ORDER BY seq LIMIT ?`,
        )
        .all(...params, query.after, query.limit + 1) as Record<
        string,
        unknown
      >[];
      const visible = page.slice(0, query.limit);
      return {
        rows: rows(query.collection, visible),
        total,
        nextCursor:
          page.length > query.limit ? Number(visible.at(-1)!.seq) : null,
      };
    },
    upsert(value: ProfileRecord): ProfileRecord {
      const parsed = ProfileRecordSchema.parse(value),
        kind = parsed.collection,
        spec: Definition = definitions[kind],
        record = parsed.record as unknown as Record<string, unknown>,
        name = table(kind);
      return transaction(kind, () => {
        const fields = spec.text.concat(spec.bool),
          values = Object.fromEntries(
            fields.map((field) => [field, record[field]]),
          ) as Fields;
        const previous = store
          .sql(`SELECT * FROM ${name} WHERE id=?`)
          .get(parsed.record.id) as Record<string, unknown> | undefined;
        let changed = false;
        if (!previous) {
          store
            .sql(
              `INSERT INTO ${name}(id,${fields.map((field) => quote(column(field))).join(",")}) VALUES (?,${fields.map(() => "?").join(",")})`,
            )
            .run(
              parsed.record.id,
              ...fields.map((field) => encode(values[field])),
            );
          changed = true;
        } else {
          const changedFields = fields.filter(
            (field) => encode(values[field]) !== previous[column(field)],
          );
          if (changedFields.length) {
            store
              .sql(
                `UPDATE ${name} SET ${changedFields.map((field) => `${quote(column(field))}=?`).join(",")} WHERE id=?`,
              )
              .run(
                ...changedFields.map((field) => encode(values[field])),
                parsed.record.id,
              );
            changed = true;
          }
        }
        for (const field of spec.lists)
          changed =
            items.patch(
              kind,
              parsed.record.id,
              field,
              record[field] as string[],
            ) || changed;
        if (changed) invalidateUnapprovedProfileResumes(store);
        if (changed)
          store.notify({
            cause: "profile",
            stages: [],
            ids: [],
            searchId: null,
          });
        return parsed;
      });
    },
    remove(kind: ProfileRecordCollection, id: string): boolean {
      return transaction(kind, () => {
        const removed = store
          .sql(`DELETE FROM ${table(kind)} WHERE id=?`)
          .run(id).changes;
        if (!removed) return false;
        store
          .sql("DELETE FROM profile_items WHERE scope=? AND owner=?")
          .run(kind, id);
        invalidateUnapprovedProfileResumes(store);
        store.notify({ cause: "profile", stages: [], ids: [], searchId: null });
        return true;
      });
    },
  };
}
import { invalidateUnapprovedProfileResumes } from "./profile-effects";
