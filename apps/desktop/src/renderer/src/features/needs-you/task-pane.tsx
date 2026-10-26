import { useEffect, useRef, useState } from "react";
import type {
  CandidateAssetKind,
  NeedsYouDetails,
  NeedsYouDraft,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { AnswerField } from "./answer-field";
import { SourceNeedPane } from "./source-need-pane";

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

  // Browser steps can advance (sign-in → MFA) without a button press here.
  // Question drafts keep their own stable editor and never refresh underneath typing.
  const accessTask = details?.task.kind !== "question" && !!details;
  useEffect(() => {
    if (!accessTask) return;
    let live = true;
    const unsubscribe = window.nestor.jobs.onChange((change) => {
      if (change.cause !== "application") return;
      void window.nestor.needsYou
        .run("get_need", { id })
        .then((value) => {
          if (live) setDetails(value);
        })
        .catch(() => undefined);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [id, accessTask]);

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
  async function answer() {
    await saveDraft();
    const result = await window.nestor.needsYou.run("answer_need", {
      id,
      answer: latest.current.answer,
      remember: latest.current.remember,
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
        <SourceNeedPane source={task.source} />
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
          {task.kind === "question" ? (
            <>
              {task.input === "file" ? (
                <div className="grid gap-3">
                  <h2 className="font-medium">{task.prompt}</h2>
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
                              !draft.remember && application
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
                {task.kind === "sign_in"
                  ? "Sign in to continue"
                  : task.kind === "captcha"
                    ? "Complete the CAPTCHA"
                    : "Complete verification"}
              </h2>
              <p className="text-sm text-foreground-soft">{task.prompt}</p>
              <p className="text-sm text-foreground-muted">
                Finish this step in the browser. Waiting applications continue
                automatically once their pages are accessible.
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
                Open in browser
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (await window.nestor.needsYou.run("check_need", { id }))
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
