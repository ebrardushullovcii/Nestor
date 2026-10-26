import { useState } from "react";
import type { SavedFormAnswer } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { describeError } from "./task-pane";
import { OptionFallbackField } from "./option-fallback-field";

export function CreateAnswerPane(props: {
  onCreated: (value: SavedFormAnswer) => void;
  onEditing: (value: boolean) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [fallback, setFallback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section
      id="list-detail"
      aria-label="New saved answer"
      className="surface-panel-shell grid content-start gap-5 overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-5"
    >
      <h2 className="font-medium">Save an answer for future forms</h2>
      <label className="grid gap-2">
        Question
        <Input
          maxLength={2000}
          placeholder="For example: Years of analysis experience"
          value={prompt}
          onChange={(event) => {
            setPrompt(event.target.value);
            props.onEditing(true);
          }}
        />
      </label>
      <label className="grid gap-2">
        Your answer
        <Textarea
          maxLength={20000}
          className="min-h-32"
          placeholder="For example: 5"
          value={answer}
          onChange={(event) => {
            setAnswer(event.target.value);
            props.onEditing(true);
          }}
        />
      </label>
      <p className="text-xs text-foreground-muted">
        Job Finder reuses this fact when a form asks the same question. Keep
        country-specific authorization and sponsorship facts in Profile.
      </p>
      <OptionFallbackField
        value={fallback}
        disabled={busy}
        onChange={(value) => {
          setFallback(value);
          props.onEditing(true);
        }}
      />
      <Button
        disabled={
          busy ||
          !prompt.trim() ||
          !answer.trim() ||
          (fallback !== null &&
            (!fallback.trim() || answer.trim().length > 300))
        }
        onClick={() => {
          setBusy(true);
          setError(null);
          void window.nestor.needsYou
            .run("create_form_answer", {
              prompt,
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
            .then(props.onCreated)
            .catch((error) => setError(describeError(error)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "Saving…" : "Save answer"}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
