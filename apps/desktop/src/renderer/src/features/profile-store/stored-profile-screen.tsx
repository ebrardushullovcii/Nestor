import { useMemo, useState, useCallback, type ComponentProps } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CandidateProfileSchema,
  type ProfileRecord,
  type ProfileRecordCollection,
  type ProfileOverview,
} from "@nestor/contracts";
import { ProfileScreen } from "@renderer/features/job-finder/screens/profile-screen";
import { Input } from "@renderer/components/ui/input";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeaderStack } from "@renderer/features/job-finder/components/page-header";
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
  | "recordStatus"
  | "recordSummary"
  | "sourceInfo"
>;
/** Reads are local to Profile; autosave commits only edited rows and fields. */
export function StoredProfileScreen(props: ProfilePorts) {
  const store = useStoredProfile(),
    settings = useStoredSettings(),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState<{
      upsert: ProfileRecord[];
      remove: { collection: ProfileRecordCollection; id: string }[];
    }>({ upsert: [], remove: [] }),
    [message, setMessage] = useState<string | null>(null),
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
  const onDirtyChange = useCallback(
    (value: boolean) => {
      setDirty(value);
      props.onProfileSurfaceDirtyChange(value);
    },
    [props.onProfileSurfaceDirtyChange],
  );
  const onDraftEdited = useCallback(() => {
    setMessage(null);
    props.onProfileSurfaceDraftEdited?.();
  }, [props.onProfileSurfaceDraftEdited]);
  function changePage(collection: ProfileRecordCollection, change: () => void) {
    setSaved((previous) => ({
      upsert: previous.upsert.filter((row) => row.collection !== collection),
      remove: previous.remove.filter((row) => row.collection !== collection),
    }));
    change();
  }
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
      <LockedScreenLayout
        topContent={
          <PageHeaderStack
            title="Profile"
            description="Everything Job Finder knows about you. Edit any field or ask the assistant."
          />
        }
      >
        {store.error ? (
          <p role="alert">
            {store.error}{" "}
            <Button onClick={() => void store.refresh()}>Try again</Button>
          </p>
        ) : (
          <p role="status">Loading your profile…</p>
        )}
      </LockedScreenLayout>
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
        .filter(
          ({ page }) =>
            (store.overview!.counts[page.collection] ?? 0) > 25 ||
            page.text ||
            page.index > 0 ||
            page.error,
        )
        .map(({ name, page }) => (
          <nav
            key={name}
            aria-label={`${name} pages`}
            className="mb-3 flex flex-wrap items-center gap-3 text-sm"
          >
            <strong>{name}</strong>
            <Input
              aria-label={`Filter ${name.toLowerCase()}`}
              className="max-w-64"
              value={page.text}
              disabled={dirty}
              onChange={(event) =>
                changePage(page.collection, () =>
                  page.setText(event.target.value),
                )
              }
            />
            {page.error ? <span role="alert">{page.error}</span> : null}
            <Button
              size="toolbar"
              variant="ghost"
              disabled={dirty || page.loading || page.index === 0}
              onClick={() => changePage(page.collection, page.previous)}
            >
              Previous
            </Button>
            <span>
              {page.total ? page.index * 25 + 1 : 0}–
              {page.index * 25 + page.rows.length} of {page.total}
            </span>
            <Button
              size="toolbar"
              variant="ghost"
              disabled={dirty || page.loading || page.nextCursor === null}
              onClick={() => changePage(page.collection, page.next)}
            >
              Next
            </Button>
            {dirty ? <span>Saving your changes…</span> : null}
          </nav>
        ))}
    </>
  );
  return (
    <>
      {store.error || settings.error ? (
        <p role="alert">{store.error ?? settings.error}</p>
      ) : null}
      <ProfileScreen
        {...props}
        onProfileSurfaceDraftEdited={onDraftEdited}
        actionState={{ message }}
        profile={profile}
        searchPreferences={store.goals}
        sourceInfo={store.overview}
        recordPaging={paging}
        recordSummary={store.overview}
        recordStatus={
          pages.some(({ page }) => page.loading || page.error) ? (
            <div role="status">
              {pages
                .filter(({ page }) => page.loading || page.error)
                .map(({ name, page }) => (
                  <p key={name}>
                    {page.error ?? `Loading ${name.toLowerCase()}…`}
                    {page.error ? (
                      <Button onClick={page.refresh}>Try again</Button>
                    ) : null}
                  </p>
                ))}
            </div>
          ) : null
        }
        pendingActions={{
          ...props.pendingActions,
          profileMutation: store.saving || props.pendingActions.profileMutation,
        }}
        onProfileSurfaceDirtyChange={onDirtyChange}
        resumeApplicationMode={settings.settings?.resumeApplicationMode}
        onUpdateResumeApproach={async (approach) => {
          const ok = await settings.updateResumeApproach(approach);
          if (ok) {
            await store.refresh();
            setMessage("Resume level saved.");
          }
          return ok;
        }}
        onSaveAll={async (nextProfile, nextGoals) => {
          const patch = profileEdits({
            overview: store.overview!,
            records,
            goals: store.goals!,
            nextProfile,
            nextGoals,
          });
          const ok = await store.save(patch);
          if (ok) {
            setSaved((previous) => {
              const key = (row: {
                collection: ProfileRecordCollection;
                id?: string;
                record?: { id: string };
              }) => `${row.collection}:${row.id ?? row.record!.id}`;
              const changed = new Set(
                [...patch.upsert, ...patch.remove].map(key),
              );
              return {
                upsert: [
                  ...previous.upsert.filter((row) => !changed.has(key(row))),
                  ...patch.upsert,
                ],
                remove: [
                  ...previous.remove.filter((row) => !changed.has(key(row))),
                  ...patch.remove,
                ],
              };
            });
            setMessage("Profile saved.");
          }
          return ok;
        }}
      />
    </>
  );
}
