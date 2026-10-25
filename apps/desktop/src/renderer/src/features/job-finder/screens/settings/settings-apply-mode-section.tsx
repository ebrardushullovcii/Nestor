import { useEffect, useId, useState } from "react";
import {
  APPLY_MODE_OPTIONS,
  ChoiceCards,
} from "@renderer/features/job-finder/components/choice-cards";
import { Switch } from "@renderer/components/ui/switch";
import type {
  ApplicationSalaryDisclosureRule,
  ApplicationApplyMode,
} from "@nestor/contracts";

/**
 * What every Apply and Apply to all does from now on, said once the choice
 * has saved, so the person reads which mode the next journey will use.
 */
const SAVED_MODE_SENTENCE: Record<ApplicationApplyMode, string> = {
  confirm_before_submit:
    "Saved. Apply fills in each form and attaches your resume; you press Send.",
  autonomous_submit:
    "Saved. From now on Apply fills in and sends each application, and pauses only when it needs you.",
};

/** Runs a save now, turning a synchronous throw into a rejected promise. */
function startSave(save: () => void | Promise<void>): Promise<void> {
  try {
    return Promise.resolve(save());
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

type ModeSaveState = {
  status: "idle" | "saving" | "saved" | "failed";
  message: string | null;
};

/**
 * The two application defaults. The task-specific permission is
 * assembled when an application starts; Settings stores only the person's
 * ordinary choice, never an empty authority envelope.
 *
 * The mode is one switch (ADR 0022): pressing a card saves it. It used to
 * wait for a separate Save button further down, and a person who picked
 * "Send for me" and went back to Home lost the choice without a word; the
 * next Apply to all then ran in the old mode.
 */
export function SettingsApplyModeSection(props: {
  headingId?: string;
  mode: ApplicationApplyMode;
  onSave: (input: { mode: ApplicationApplyMode }) => void | Promise<void>;
  salaryDisclosure?: ApplicationSalaryDisclosureRule;
  onSaveSalaryDisclosure?: (
    value: ApplicationSalaryDisclosureRule,
  ) => Promise<void>;
  isSaving?: boolean;
}) {
  const { headingId, isSaving = false, mode, onSave } = props;
  const payId = useId();
  const payDescriptionId = useId();
  const [payChoice, setPayChoice] = useState(
    props.salaryDisclosure ?? "pause_for_user",
  );
  const [paySaving, setPaySaving] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  useEffect(() => {
    setPayChoice(props.salaryDisclosure ?? "pause_for_user");
  }, [props.salaryDisclosure]);
  const choosePay = (checked: boolean) => {
    if (paySaving || isSaving || !props.onSaveSalaryDisclosure) return;
    const previous = payChoice;
    const next = checked ? "answer_from_profile" : "pause_for_user";
    setPayChoice(next);
    setPaySaving(true);
    setPayError(null);
    void props
      .onSaveSalaryDisclosure(next)
      .catch(() => {
        setPayChoice(previous);
        setPayError("Your pay choice did not save. Try again.");
      })
      .finally(() => setPaySaving(false));
  };
  const [selectedMode, setSelectedMode] = useState(mode);
  const [modeSave, setModeSave] = useState<ModeSaveState>({
    status: "idle",
    message: null,
  });
  const modeSaving = modeSave.status === "saving";

  useEffect(() => {
    setSelectedMode(mode);
  }, [mode]);
  const chooseMode = (value: ApplicationApplyMode) => {
    if (isSaving || modeSaving) return;
    if (value === mode && modeSave.status !== "failed") {
      setSelectedMode(value);
      return;
    }
    const previous = mode;
    setSelectedMode(value);
    setModeSave({ status: "saving", message: null });
    void startSave(() =>
      onSave({
        mode: value,
      }),
    ).then(
      () => {
        setModeSave({ status: "saved", message: SAVED_MODE_SENTENCE[value] });
      },
      () => {
        setSelectedMode(previous);
        setModeSave({
          status: "failed",
          message:
            "That did not save, so Apply still uses the mode shown. Try again.",
        });
      },
    );
  };

  return (
    <section className="surface-panel-shell grid min-w-0 content-start gap-4 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <h3
            className="min-w-0 font-semibold text-(--text-headline)"
            id={headingId}
          >
            Applying
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            What Apply does. Your choice saves as soon as you pick it, and every
            Apply and Apply to all uses it until you change it here.
          </p>
        </div>
      </div>

      <ChoiceCards
        aria-label="Default application mode"
        disabled={isSaving || modeSaving}
        onChange={chooseMode}
        options={APPLY_MODE_OPTIONS}
        value={selectedMode}
      />
      {modeSave.message ? (
        <p
          className={
            modeSave.status === "failed"
              ? "text-sm leading-5 text-destructive"
              : "text-sm leading-5 text-(--success-text)"
          }
          data-apply-mode-save-state={modeSave.status}
          role={modeSave.status === "failed" ? "alert" : "status"}
        >
          {modeSave.message}
        </p>
      ) : null}

      <p className="text-sm leading-5 text-foreground-soft">
        Job Finder fills applications and sends them only with your permission.
        It never asks for a password. If you provide sign-in details and
        authorize their use, it may use them for that task without saving them.
        You control account creation; CAPTCHA and MFA stay with you.
      </p>

      <div className="grid gap-2 border-t border-(--surface-panel-border) pt-4">
        <div className="flex items-start justify-between gap-4">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={payId}
          >
            Let Job Finder answer expected and current pay questions
          </label>
          <Switch
            id={payId}
            checked={payChoice === "answer_from_profile"}
            disabled={isSaving || paySaving || !props.onSaveSalaryDisclosure}
            aria-describedby={payDescriptionId}
            onCheckedChange={choosePay}
          />
        </div>
        <p
          id={payDescriptionId}
          className="text-(length:--text-small) leading-5 text-foreground-soft"
        >
          Includes pay history. Off: optional pay fields stay blank; required
          questions wait for you. On: answers use your saved facts. Expected pay
          never answers current pay. Your choice saves when you change it.
        </p>
        {payError ? (
          <p role="alert" className="text-sm text-destructive">
            {payError}
          </p>
        ) : null}
      </div>
    </section>
  );
    }
