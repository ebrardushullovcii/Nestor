import { useEffect, useState } from "react";
import type { SavedFormAnswer } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { AnswerField } from "./answer-field";
import { describeError } from "./task-pane";
import { OptionFallbackField } from "./option-fallback-field";

export function SavedAnswerPane(props: {
  id: number;
  onEditing: (editing: boolean) => void;
  onSaved: (message: string) => void;
  onForget: (ids: number[]) => Promise<void>;
}) {
  const [value, setValue] = useState<SavedFormAnswer | null>(null);
  const [answer, setAnswer] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void window.nestor.needsYou
      .run("get_form_answer", { id: props.id })
      .then((value) => {
        if (live) {
          setValue(value);
          setAnswer(value?.answer ?? "");
          setFallback(value?.optionFallback?.fallback ?? null);
          setLoaded(true);
        }
      })
      .catch((reason) => {
        if (live) {
          setError(describeError(reason));
          setLoaded(true);
        }
      });
    return () => {
      live = false;
    };
  }, [props.id]);
  return (
    <section
      id="list-detail"
      aria-label="Saved answer"
      className="surface-panel-shell min-h-0 overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
    >
      {!loaded ? (
        <p>Loading answer…</p>
      ) : !value ? (
        <p>This answer has been forgotten.</p>
      ) : (
        <div className="grid gap-5">
          <p className="text-sm text-foreground-soft">
            {[value.scope.country, value.scope.siteOrigin]
              .filter(Boolean)
              .join(" · ") || "Used wherever the same question appears."}
          </p>
          {value.needsConfirmation ? (
            <p className="text-sm">
              Review this suggested answer before it is reused.
            </p>
          ) : null}
          {value.input === "file" ? (
            <>
              <h2>{value.prompt}</h2>
              <p className="break-words text-sm">
                {value.answer.replace(/ \(saved file .*\)\.$/u, "")}
              </p>
            </>
          ) : (
            <AnswerField
              question={value}
              value={answer}
              onChange={(next) => {
                setAnswer(next);
                props.onEditing(true);
              }}
              disabled={busy}
            />
          )}
          <p className="text-xs text-foreground-muted">
            Changes are used the next time a form is filled. Submitted
            applications keep their original answers.
          </p>
          {value.input !== "file" ? (
            <OptionFallbackField
              value={fallback}
              disabled={busy}
              onChange={(next) => {
                setFallback(next);
                props.onEditing(true);
              }}
            />
          ) : null}
          <div className="flex gap-2">
            {value.input !== "file" ? (
              <Button
                disabled={
                  busy ||
                  !answer.trim() ||
                  (fallback !== null &&
                    (!fallback.trim() || answer.trim().length > 300))
                }
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void window.nestor.needsYou
                    .run("save_form_answer", {
                      id: props.id,
                      answer,
                      optionFallback:
                        fallback === null
                          ? null
                          : {
                              primary: answer.trim(),
                              fallback: fallback.trim(),
                              whenNeitherOffered: "skip_application",
                            },
                    })
                    .then(({ saved }) => {
                      if (!saved)
                        throw new Error("This answer no longer exists.");
                      props.onEditing(false);
                      props.onSaved("Saved answer updated.");
                    })
                    .catch((reason) => setError(describeError(reason)))
                    .finally(() => setBusy(false));
                }}
              >
                Save answer
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void props
                  .onForget([props.id])
                  .catch((reason) => setError(describeError(reason)))
                  .finally(() => setBusy(false));
              }}
            >
              Forget answer
            </Button>
          </div>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
