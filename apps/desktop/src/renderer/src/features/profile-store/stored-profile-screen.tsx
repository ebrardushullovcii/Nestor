import { useMemo, useState, useRef, type ComponentProps } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CandidateProfileSchema,
  type ProfileRecord,
  type ProfileRecordCollection,
  type ProfileOverview,
} from "@nestor/contracts";
import { ProfileScreen } from "@renderer/features/job-finder/screens/profile-screen";
import { Button } from "@renderer/components/ui/button";
import { useStoredSettings } from "./use-stored-settings";
import { useStoredProfile, useProfileRecordPage } from "./use-stored-profile";
import { profileEdits } from "./profile-edits";

function expand(
  values: Record<string, unknown>,
  target: Record<string, unknown> = {},
) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const path = key.split(".");
    let parent = target;
    for (const part of path.slice(0, -1)) {
      const child = parent[part];
      if (!child || typeof child !== "object" || Array.isArray(child))
        parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[path.at(-1)!] = value;
  }
  return target;
}
function editorProfile(
  overview: ProfileOverview,
  rows: Partial<Record<ProfileRecordCollection, readonly ProfileRecord[]>>,
) {
  const fields = expand({ ...overview.fields, ...overview.lists });
  for (const [kind, values] of Object.entries(rows))
    fields[kind] = values.map((row) => row.record);
  return CandidateProfileSchema.parse({
    ...fields,
    id: overview.id,
    baseResume: { ...overview.resume, textContent: null, storagePath: null },
    resumeIdentityOwnership: overview.resumeIdentityOwnership,
    workEligibility: {
      ...(fields.workEligibility as Record<string, unknown>),
      limitedWorkPermissions: overview.limitedWorkPermissions,
    },
  });
}
type ProfilePorts = Omit<
  ComponentProps<typeof ProfileScreen>,
  | "profile"
  | "searchPreferences"
  | "onSaveAll"
  | "onUpdateResumeApproach"
  | "resumeApplicationMode"
  | "recordPaging"
  | "sourceInfo"
>;
/** Reads are local to Profile; Save commits only edited rows and fields. */
export function StoredProfileScreen(props: ProfilePorts) {
  const store = useStoredProfile(),
    settings = useStoredSettings(),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState<{
      upsert: ProfileRecord[];
      remove: { collection: ProfileRecordCollection; id: string }[];
    }>({ upsert: [], remove: [] }),
    [epoch, setEpoch] = useState(0),
    draftRevision = useRef(0),
    [params] = useSearchParams(),
    section = params.get("section") ?? "basics";
  const experiences = useProfileRecordPage(
      "experiences",
      section === "experience",
    ),
    education = useProfileRecordPage("education", section === "background"),
    certifications = useProfileRecordPage(
      "certifications",
      section === "background",
    ),
    links = useProfileRecordPage("links", section === "background"),
    projects = useProfileRecordPage("projects", section === "background"),
    languages = useProfileRecordPage(
      "spokenLanguages",
      section === "background",
    ),
    proof = useProfileRecordPage("proofBank", section === "background");
  const baseRecords = useMemo(
    () => ({
      experiences: experiences.rows,
      education: education.rows,
      certifications: certifications.rows,
      links: links.rows,
      projects: projects.rows,
      spokenLanguages: languages.rows,
      proofBank: proof.rows,
    }),
    [
      experiences.rows,
      education.rows,
      certifications.rows,
      links.rows,
      projects.rows,
      languages.rows,
      proof.rows,
    ],
  );
  const records = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(baseRecords).map(([kind, rows]) => {
          const byId = new Map(rows.map((row) => [row.record.id, row]));
          for (const row of saved.upsert)
            if (row.collection === kind) byId.set(row.record.id, row);
          for (const row of saved.remove)
            if (row.collection === kind) byId.delete(row.id);
          return [kind, [...byId.values()]];
        }),
      ) as typeof baseRecords,
    [baseRecords, saved],
  );
  const profile = useMemo(
    () => (store.overview ? editorProfile(store.overview, records) : null),
    [store.overview, records],
  );
  if (!profile || !store.goals || !store.overview)
    return (
      <section aria-label="Profile">
        <h1>Profile</h1>
        {store.error ? (
          <p role="alert">
            {store.error}{" "}
            <Button onClick={() => void store.refresh()}>Try again</Button>
          </p>
        ) : (
          <p role="status">Loading your profile…</p>
        )}
      </section>
    );
  const pages =
    section === "experience"
      ? [{ name: "Work history", page: experiences }]
      : section === "background"
        ? [
            { name: "Education", page: education },
            { name: "Certifications", page: certifications },
            { name: "Links", page: links },
            { name: "Projects", page: projects },
            { name: "Languages", page: languages },
            { name: "Proof", page: proof },
          ]
        : [];
  const paging = (
    <>
      {pages
        .filter(({ page }) => page.total > 25 || page.index > 0 || page.error)
        .map(({ name, page }) => (
          <nav
            key={name}
            aria-label={`${name} pages`}
            className="mb-3 flex items-center gap-3 text-sm"
          >
            <strong>{name}</strong>
            {page.error ? <span role="alert">{page.error}</span> : null}
            <Button
              size="toolbar"
              variant="ghost"
              disabled={dirty || page.loading || page.index === 0}
              onClick={page.previous}
            >
              Previous
            </Button>
            <span>
              {page.index * 25 + 1}–{page.index * 25 + page.rows.length} of{" "}
              {page.total}
            </span>
            <Button
              size="toolbar"
              variant="ghost"
              disabled={dirty || page.loading || page.nextCursor === null}
              onClick={page.next}
            >
              Next
            </Button>
            {dirty ? <span>Save changes before changing pages.</span> : null}
          </nav>
        ))}
    </>
  );
  return (
    <>
      {store.error ? <p role="alert">{store.error}</p> : null}
      <ProfileScreen
        {...props}
        key={epoch}
        onProfileSurfaceDraftEdited={() => {
          draftRevision.current++;
          props.onProfileSurfaceDraftEdited?.();
        }}
        profile={profile}
        searchPreferences={store.goals}
        sourceInfo={store.overview}
        recordPaging={paging}
        pendingActions={{
          ...props.pendingActions,
          profileMutation: store.saving || props.pendingActions.profileMutation,
        }}
        onProfileSurfaceDirtyChange={(value) => {
          setDirty(value);
          props.onProfileSurfaceDirtyChange(value);
        }}
        resumeApplicationMode={settings.settings?.resumeApplicationMode}
        onUpdateResumeApproach={async (approach) => {
          await window.nestor.jobs.run("set_resume_approach", { approach });
          await store.refresh();
          return true;
        }}
        onSaveAll={(nextProfile, nextGoals) => {
          const revision = draftRevision.current,
            patch = profileEdits({
              overview: store.overview!,
              records,
              goals: store.goals!,
              nextProfile,
              nextGoals,
            });
          void store.save(patch).then((ok) => {
            if (!ok) return;
            setSaved((previous) => ({
              upsert: [...previous.upsert, ...(patch.upsert ?? [])],
              remove: [...previous.remove, ...(patch.remove ?? [])],
            }));
            if (draftRevision.current === revision)
              setEpoch((value) => value + 1);
          });
        }}
      />
    </>
  );
}
