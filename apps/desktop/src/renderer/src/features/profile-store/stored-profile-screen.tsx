import { useMemo, useState, useRef, useCallback } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  type ProfileRecord,
  type ProfileRecordCollection,
  type CandidateProfile,
  type JobSearchPreferences,
  type ProfileEditBatch,
} from "@nestor/contracts";
import { ProfileScreen } from "@renderer/features/job-finder/screens/profile-screen";
import { Input } from "@renderer/components/ui/input";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import { PageHeaderStack } from "@renderer/features/job-finder/components/page-header";
import { Button } from "@renderer/components/ui/button";
import { useStoredSettings } from "./use-stored-settings";
import { useStoredProfile, useProfileRecordPage } from "./use-stored-profile";
import { editorProfile, profileEdits } from "./profile-edits";
import { RecoveredProfileDraft } from "./recovered-profile-draft";
import { getDefaultProfileRoute } from "@renderer/features/job-finder/lib/job-finder-utils";
import { useProfileWorkflow } from "./use-profile-workflow";
import { ProfileLeaveGuard } from "./profile-leave-guard";
import { resumeGuidedSetup } from "./guided-setup";

const IMPORT_GUARD =
  "Save this step before importing or refreshing from a resume.";

/** Reads are local to Profile; autosave commits only edited rows and fields. */
export function StoredProfileScreen() {
  const store = useStoredProfile(),
    settings = useStoredSettings(),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState<{
      upsert: ProfileRecord[];
      remove: { collection: ProfileRecordCollection; id: string }[];
    }>({ upsert: [], remove: [] }),
    [blockLeave, setBlockLeave] = useState(false),
    [params] = useSearchParams(),
    section = params.get("section") ?? "basics";
  const workflow = useProfileWorkflow({
      siteInstructions: section === "sources",
    }),
    setMessage = workflow.setMessage;
  const navigate = useNavigate();
  const location = useLocation();
  const ownWrites = useRef(
    new Map<string, { before: unknown; after: unknown }>(),
  );
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
    (value: boolean, blockNavigation = false) => {
      setDirty(value);
      setBlockLeave(value && blockNavigation);
    },
    [],
  );
  const onDraftEdited = useCallback(() => {
    setMessage(null);
  }, [setMessage]);
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
  const keptDraft = useRef<{ key: string; id: string } | null>(null);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  function prepareEdits(
    nextProfile: CandidateProfile,
    nextGoals: JobSearchPreferences,
    baseline?: { profile: CandidateProfile; goals: JobSearchPreferences },
  ) {
    const patch = profileEdits({
      overview: store.overview!,
      records,
      goals: store.goals!,
      nextProfile,
      nextGoals,
      ...(baseline
        ? { beforeProfile: baseline.profile, beforeGoals: baseline.goals }
        : {}),
    });
    for (const [scope, values] of [
      ["profile", patch.profile],
      ["goals", patch.goals],
    ] as const) {
      for (const [kind, expected] of [
        ["fields", values?.expected],
        ["lists", values?.expectedLists],
      ] as const) {
        if (!expected) continue;
        for (const key of Object.keys(expected)) {
          const previous = ownWrites.current.get(`${scope}.${kind}.${key}`);
          if (
            previous &&
            same((expected as Record<string, unknown>)[key], previous.before)
          )
            Object.assign(expected, { [key]: previous.after });
        }
      }
    }
    for (const row of patch.expectedRecords) {
      const previous = ownWrites.current.get(
        `record.${row.collection}.${row.id}`,
      );
      if (previous && same(row.value, previous.before))
        row.value = previous.after as typeof row.value;
    }
    return patch;
  }
  function draftFor(patch: ProfileEditBatch) {
    const key = JSON.stringify(patch);
    if (keptDraft.current?.key !== key)
      keptDraft.current = { key, id: crypto.randomUUID() };
    return { id: keptDraft.current.id, edits: patch };
  }
  const setupState = workflow.state?.profileSetupState;
  if (
    setupState &&
    getDefaultProfileRoute(setupState, {
      forceFullProfile: Boolean(
        (location.state as { forceFullProfile?: boolean } | null)
          ?.forceFullProfile,
      ),
    }) !== "/job-finder/profile"
  )
    return <Navigate replace to="/job-finder/profile/setup" />;
  if (!profile || !store.goals || !store.overview || !workflow.state)
    return (
      <LockedScreenLayout
        topContent={
          <PageHeaderStack
            title="Profile"
            description="Everything Job Finder knows about you. Edit any field or ask the assistant."
          />
        }
      >
        {(store.error ?? workflow.error) ? (
          <p role="alert">
            {store.error ?? workflow.error}{" "}
            <Button
              onClick={() => {
                void store.refresh();
                void workflow.refresh();
              }}
            >
              Try again
            </Button>
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
      <RecoveredProfileDraft onRestored={store.refresh} />
      <ProfileLeaveGuard
        dirty={blockLeave}
        saving={store.saving ? "Profile" : null}
      />
      <ProfileScreen
        onProfileSurfaceDraftEdited={onDraftEdited}
        actionState={{ message: workflow.message }}
        importResumeGuardMessage={blockLeave ? IMPORT_GUARD : null}
        onApplyProfileSetupReviewAction={(reviewItemId, action, options) =>
          void workflow.applyReviewAction(reviewItemId, action, options)
        }
        onAnalyzeProfileFromResume={() => {
          if (blockLeave) setMessage(IMPORT_GUARD);
          else void workflow.analyzeResume();
        }}
        onApplyResumeTimelineRepairAction={workflow.applyTimelineRepair}
        onImportResume={() => {
          if (blockLeave) setMessage(IMPORT_GUARD);
          else void workflow.importResume();
        }}
        onRetryInterruptedImport={() =>
          void workflow.importResume({ retryInterrupted: true })
        }
        onResumeProfileSetup={(step) =>
          void resumeGuidedSetup(workflow, navigate, location.pathname, step)
        }
        onRunSourceDebug={(targetId) => void workflow.checkSite(targetId)}
        onSaveSourceInstructionArtifact={(targetId, artifact) =>
          void workflow.saveSiteInstructions(targetId, artifact)
        }
        latestResumeImportReviewCandidates={
          workflow.state.latestResumeImportReviewCandidates
        }
        latestResumeImportRun={workflow.state.latestResumeImportRun}
        resumeImportProgress={workflow.importProgress}
        profileSetupState={workflow.state.profileSetupState}
        sourceInstructionArtifacts={workflow.siteInstructions}
        profile={profile}
        searchPreferences={store.goals}
        sourceInfo={store.overview}
        recordPaging={paging}
        recordSummary={store.overview}
        recordStatus={
          pages.some(({ page }) => page.loading) ? (
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
          analyzeProfile: workflow.isPending("analyze"),
          importResume: workflow.isPending("import"),
          profileCopilotBusy: false,
          profileMutation: store.saving,
          profileSetup: workflow.isPending("setup"),
          profileReviewItem: (id) => workflow.isPending(`review:${id}`),
          sourceDebug: (id) => workflow.isPending(`site:${id}`),
          sourceInstruction: (id) => workflow.isPending(`instruction:${id}`),
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
        onPreserveEdits={async (nextProfile, nextGoals, baseline) => {
          await window.nestor.jobs.run(
            "put_profile_draft",
            draftFor(prepareEdits(nextProfile, nextGoals, baseline)),
          );
        }}
        onDiscardEdits={async () => {
          if (keptDraft.current)
            await window.nestor.jobs.run("clear_profile_draft", {
              id: keptDraft.current.id,
            });
        }}
        onSaveAll={async (nextProfile, nextGoals, _section, baseline) => {
          const patch = prepareEdits(nextProfile, nextGoals, baseline);
          const draft = draftFor(patch);
          await window.nestor.jobs.run("put_profile_draft", draft);
          const ok = await store.save({ ...patch, draftId: draft.id });
          if (ok) {
            for (const [scope, values] of [
              ["profile", patch.profile],
              ["goals", patch.goals],
            ] as const)
              for (const [kind, changes, expected] of [
                ["fields", values?.fields, values?.expected],
                ["lists", values?.lists, values?.expectedLists],
              ] as const)
                for (const [key, value] of Object.entries(changes ?? {}))
                  ownWrites.current.set(`${scope}.${kind}.${key}`, {
                    before: expected?.[key as keyof typeof expected],
                    after: value,
                  });
            for (const row of patch.expectedRecords)
              ownWrites.current.set(`record.${row.collection}.${row.id}`, {
                before: row.value,
                after:
                  patch.upsert.find(
                    (value) =>
                      value.collection === row.collection &&
                      value.record.id === row.id,
                  ) ?? null,
              });
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
