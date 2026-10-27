import { useEffect, useRef, useState } from "react";
import type {
  CandidateAssetKind,
  NeedsYouDetails,
  NeedsYouDraft,
} from "@nestor/contracts";
import {
  STEP_PRESSED_ANSWER,
  UPLOAD_ATTACHED_ANSWER,
  isStepHandoverPrompt,
  isUploadRepairPrompt,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { useToast } from "@renderer/components/ui/toast";
import { openPreparedApplication } from "@renderer/features/applications/open-application";
import { AnswerField } from "./answer-field";
import { SourceNeedPane } from "./source-need-pane";
import { siteCheck, useWorkThrough } from "./work-through";

/** A site as a person names it: its host, without "www.". */
function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : "Could not save this answer.";

/** Each mounted editor belongs to one task. Async reads and saves cannot retarget it. */
export function TaskPane(props: {
  id: number;
  onEditing: (editing: boolean) => void;
  onResolved: (id: number, message: string) => void;
  onMissing?: (id: number) => void;
}) {
  const { id, onEditing, onResolved } = props;
  const { showToast } = useToast();
  const onMissing = useRef(props.onMissing);
  onMissing.current = props.onMissing;
  const [details, setDetails] = useState<NeedsYouDetails | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<NeedsYouDraft>({
    answer: "",
    remember: true,
    revision: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileKind, setFileKind] = useState<CandidateAssetKind>("other");
  const latest = useRef(draft);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saves = useRef(Promise.resolve());
  const live = useRef(true);
  const conflict = useRef(false);

  useEffect(() => {
    live.current = true;
    void window.nestor.needsYou
      .run("get_need", { id })
      .then((value) => {
        if (!live.current) return;
        if (!value) onMissing.current?.(id);
        setDetails(value);
        const restored = value?.draft ?? {
          answer: "",
          remember: true,
          revision: 0,
        };
        latest.current = restored;
        setDraft(restored);
        setLoaded(true);
      })
      .catch((reason) => {
        if (live.current) {
          setError(describeError(reason));
          setLoaded(true);
        }
      });
    return () => {
      live.current = false;
    };
  }, [id]);

  // Access steps and a question's native format can change while it is open.
  // Refresh the question metadata, retaining the editor's own unsaved draft.
  const accessTask = details?.task.kind !== "question" && !!details;
  useEffect(() => {
    if (!loaded) return;
    let live = true;
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause !== "application") return;
      void window.nestor.needsYou
        .run("get_need", { id })
        .then((value) => {
          if (live)
            setDetails((previous) =>
              !accessTask && previous && value
                ? {
                    ...previous,
                    task: value.task,
                    applications: value.applications,
                  }
                : value,
            );
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id, accessTask, loaded]);

  function saveDraft() {
    if (pending.current) clearTimeout(pending.current);
    pending.current = null;
    const attempt = saves.current.then(async () => {
      if (conflict.current)
        throw new Error("Reopen this question to read the saved draft.");
      const value = latest.current;
      const result = await window.nestor.needsYou.run("save_need_draft", {
        id,
        ...value,
      });
      if (!result.saved) {
        conflict.current = true;
        throw new Error(
          "This answer changed in another window. Reopen the question to read the saved draft.",
        );
      }
      latest.current = { ...latest.current, revision: result.revision };
    });
    saves.current = attempt.catch((reason) => {
      if (live.current) setError(describeError(reason));
    });
    return attempt;
  }
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  useEffect(
    () => () => {
      if (pending.current) void saveRef.current().catch(() => undefined);
    },
    [],
  );

  function edit(value: Partial<NeedsYouDraft>) {
    latest.current = { ...latest.current, ...value };
    setDraft(latest.current);
    onEditing(true);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(
      () => void saveDraft().catch(() => undefined),
      350,
    );
  }
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  // A refused upload belongs to one application's page: its answer is
  // never saved for other forms.
  const perApplication =
    !!details?.task &&
    (isUploadRepairPrompt(details.task.prompt) ||
      isStepHandoverPrompt(details.task.prompt));
  async function answer() {
    await saveDraft();
    const result = await window.nestor.needsYou.run("answer_need", {
      id,
      answer: latest.current.answer,
      remember: latest.current.remember && !perApplication,
    });
    onEditing(false);
    onResolved(
      id,
      result.resolved
        ? `Answer saved. ${result.queued === 1 ? "One application continues." : `${result.queued} applications continue.`}`
        : "This question was already answered or is no longer needed.",
    );
  }
  const task = details?.task;
  const { checks } = useWorkThrough();
  return (
    <section
      id="list-detail"
      aria-label="Task details"
      data-needs-detail-id={task?.id}
      className="surface-panel-shell min-h-0 overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
    >
      {!loaded ? (
        <p role="status">Loading question…</p>
      ) : !task ? (
        <p>This item is no longer waiting for you.</p>
      ) : task.source ? (
        <SourceNeedPane
          check={siteCheck(checks, [task.id])}
          host={siteHost(task.source.url)}
          site={{
            id: task.id,
            kind: "site",
            label: task.source.label,
            taskIds: [task.id],
            sources: [{ id: task.source.id, url: task.source.url }],
          }}
        />
      ) : (
        <div className="grid gap-5">
          <div className="text-sm text-foreground-soft">
            {details.applications.map((application) => (
              <p key={application.id}>
                {application.title} · {application.company}
                {application.location ? ` · ${application.location}` : ""}
              </p>
            ))}
          </div>
          {task.kind === "question" && isStepHandoverPrompt(task.prompt) ? (
            <div className="grid gap-3">
              <h2 className="font-medium">{task.prompt}</h2>
              <p className="text-sm text-foreground-soft">
                Job Finder filled what it could on this page. In Fill in for me
                it never presses the form's own buttons, because one of them
                could send your application. Open the application, press it
                yourself, then come back here.
              </p>
              {details.applications.map((application) => (
                <Button
                  key={application.id}
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      if (
                        !(await openPreparedApplication(
                          application.id,
                          showToast,
                        ))
                      )
                        throw new Error(
                          "The form could not be opened. Try opening it again from Applications.",
                        );
                    })
                  }
                >
                  {details.applications.length === 1
                    ? "Open application"
                    : `Open ${application.title}`}
                </Button>
              ))}
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    edit({ answer: STEP_PRESSED_ANSWER, remember: false });
                    await answer();
                  })
                }
              >
                I pressed it, continue
              </Button>
            </div>
          ) : task.kind === "question" ? (
            <>
              {task.input === "file" ? (
                <div className="grid gap-3">
                  <h2 className="font-medium">{task.prompt}</h2>
                  <p className="text-sm text-foreground-soft">
                    Your other answers are kept. Open the application to finish
                    attaching the file on the site.
                  </p>
                  {details.applications.map((application) => (
                    <Button
                      key={application.id}
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          if (
                            !(await openPreparedApplication(
                              application.id,
                              showToast,
                            ))
                          )
                            throw new Error(
                              "The form could not be opened. Try opening it again from Applications.",
                            );
                        })
                      }
                    >
                      {details.applications.length === 1
                        ? "Open application"
                        : `Open ${application.title}`}
                    </Button>
                  ))}
                  {isUploadRepairPrompt(task.prompt) ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          // The site's word was wrong or stale: the person
                          // sees the file on the page and says so.
                          edit({
                            answer: UPLOAD_ATTACHED_ANSWER,
                            remember: false,
                          });
                          await answer();
                        })
                      }
                    >
                      It's attached on the site
                    </Button>
                  ) : null}
                  <label className="grid gap-2">
                    File type
                    <select
                      value={fileKind}
                      onChange={(event) =>
                        setFileKind(event.target.value as CandidateAssetKind)
                      }
                      className="rounded border bg-canvas p-2"
                    >
                      {(
                        [
                          ["other", "Other document"],
                          ["work_sample", "Work sample"],
                          ["portfolio", "Portfolio"],
                          ["certificate", "Certificate"],
                          ["transcript", "Transcript"],
                          ["image", "Image"],
                        ] as const
                      ).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const application = details.applications[0];
                        const result =
                          await window.nestor.jobFinder.importCandidateAsset({
                            kind: fileKind,
                            consentScope: "job_application_attachment",
                            forJob:
                              (!draft.remember || perApplication) && application
                                ? {
                                    jobId: String(application.jobId),
                                    title: application.title,
                                    company: application.company,
                                  }
                                : null,
                          });
                        if (result.status === "imported")
                          edit({
                            answer: `Use ${result.asset.originalName} (saved file ${result.asset.id}).`,
                          });
                      })
                    }
                  >
                    Choose a file
                  </Button>
                  {draft.answer ? (
                    <p className="break-words text-sm">
                      {draft.answer.replace(/ \(saved file .*\)\.$/u, "")}
                    </p>
                  ) : null}
                </div>
              ) : (
                <AnswerField
                  question={task}
                  value={draft.answer}
                  onChange={(answer) => edit({ answer })}
                  disabled={busy}
                />
              )}
              {perApplication ? (
                <p className="text-xs text-foreground-muted">
                  This is for this application only. Nothing is saved for other
                  forms.
                </p>
              ) : (
                <>
                  {details.draft?.answer ? (
                    <p className="text-sm text-foreground-soft">
                      Review this draft answer before saving. You can change it
                      here.
                    </p>
                  ) : null}
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.remember}
                      onCheckedChange={(value) =>
                        edit({ remember: value === true })
                      }
                      disabled={busy}
                    />
                    Save this answer for next time
                  </label>
                  <p className="text-xs text-foreground-muted">
                    One answer covers every application waiting on this same
                    question. Saved answers stay in Needs you.
                  </p>
                </>
              )}
              <Button
                disabled={busy || !draft.answer.trim()}
                onClick={() => void act(answer)}
              >
                {busy ? "Saving…" : "Save and continue"}
              </Button>
            </>
          ) : (
            <>
              <h2 className="font-medium">
                {task.blockedUrl
                  ? "This site blocked the browser"
                  : task.kind === "sign_in"
                    ? "Sign in to continue"
                    : task.kind === "captcha"
                      ? "Complete the CAPTCHA"
                      : "Complete verification"}
              </h2>
              <p className="text-sm text-foreground-soft">{task.prompt}</p>
              <p className="text-sm text-foreground-muted">
                {task.blockedUrl
                  ? "Open the job in your own browser to apply by hand. These applications stay blocked; Job Finder will not retry this site."
                  : "Finish this step in the browser. Waiting applications continue automatically once their pages are accessible."}
              </p>
              {task.scope.siteOrigin ? (
                <p className="break-all text-sm">{task.scope.siteOrigin}</p>
              ) : null}
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (
                      !(await window.nestor.needsYou.run("open_need", { id }))
                    )
                      throw new Error(
                        "This application tab is unavailable. Open the application again from Applications.",
                      );
                  })
                }
              >
                {task.blockedUrl ? "Open in my browser" : "Open in browser"}
              </Button>
              {task.blockedUrl ? (
                <p className="text-sm break-all">{task.blockedUrl}</p>
              ) : (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      if (
                        await window.nestor.needsYou.run("check_need", { id })
                      )
                        onResolved(
                          id,
                          "The browser step is complete. Applications continue.",
                        );
                      else
                        setError(
                          "The page is still waiting. Finish the browser step, then check again.",
                        );
                    })
                  }
                >
                  Check again
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {error ? (
        <div className="mt-4 grid gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          {conflict.current ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const value = await window.nestor.needsYou.run("get_need", {
                    id,
                  });
                  const restored = value?.draft ?? {
                    answer: "",
                    remember: true,
                    revision: 0,
                  };
                  latest.current = restored;
                  setDraft(restored);
                  setDetails(value);
                  conflict.current = false;
                  onEditing(false);
                })
              }
            >
              Reload saved draft
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
