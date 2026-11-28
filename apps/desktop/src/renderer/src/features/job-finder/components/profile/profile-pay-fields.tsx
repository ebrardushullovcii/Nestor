import { useId } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { FieldLabel } from "@renderer/components/ui/field";
import { FormSelect } from "../form-select";
import type { SearchPreferencesEditorValues } from "../../lib/profile-editor";
import {
  ProfileInput,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";

/**
 * The saved pay range and what it means: before or after tax, base or OTE,
 * its period and currency. Profile and Guided setup show the same fields so
 * the range is never saved without the facts the models need to read it.
 * The cells sit in the caller's two-column grid.
 */
export function ProfilePayFields(props: {
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
}) {
  const { control, register, watch } = props.preferencesForm;
  const minimumSalaryId = useId();
  const targetSalaryId = useId();
  const taxBasisId = useId();
  const taxBasisHelpId = `${taxBasisId}-help`;
  const compensationBasisId = useId();
  const compensationIntervalId = useId();
  const salaryCurrencyId = useId();

  return (
    <>
      <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
        <FieldLabel htmlFor={minimumSalaryId}>
          Minimum worth considering
        </FieldLabel>
        <ProfileInput
          id={minimumSalaryId}
          min="0"
          step="1"
          type="number"
          {...register("minimumSalaryUsd")}
        />
        <p className="text-xs leading-relaxed text-foreground-muted">
          Used as a matching floor. Strong-fit roles can still be reviewed
          deliberately.
        </p>
      </div>
      <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
        <FieldLabel htmlFor={targetSalaryId}>
          Target compensation (optional)
        </FieldLabel>
        <ProfileInput
          id={targetSalaryId}
          min="0"
          step="1"
          type="number"
          {...register("targetSalaryUsd")}
        />
        <p className="text-xs leading-relaxed text-foreground-muted">
          Your preferred target. Matching still uses the minimum as the floor,
          and higher compensation is always welcome.
        </p>
      </div>
      <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
        <FieldLabel htmlFor={taxBasisId}>Before or after tax</FieldLabel>
        <select
          aria-describedby={taxBasisHelpId}
          className={profileSelectTriggerClassName}
          id={taxBasisId}
          {...register("compensationTaxBasis")}
        >
          <option value="">Not set</option>
          <option value="before_tax">Before tax (gross)</option>
          <option value="after_tax">After tax (net, take-home)</option>
        </select>
        <p
          className="text-xs leading-relaxed text-foreground-muted"
          id={taxBasisHelpId}
        >
          Job ads and forms usually mean pay before tax. When yours is after
          tax, Nestor estimates the before-tax figure for the job&apos;s country
          and says it is an estimate.
        </p>
      </div>
      <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
        <FieldLabel htmlFor={compensationBasisId}>
          Minimum pay counts as
        </FieldLabel>
        <select
          className={profileSelectTriggerClassName}
          id={compensationBasisId}
          {...register("compensationBasis")}
        >
          <option value="base">Base salary</option>
          <option value="total_ote">
            Total pay including commission (OTE)
          </option>
        </select>
      </div>
      <Controller
        control={control}
        name="compensationInterval"
        render={({ field }) => (
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={compensationIntervalId}>
              Compensation interval
            </FieldLabel>
            <FormSelect
              onValueChange={field.onChange}
              options={[
                { label: "Hourly", value: "hour" },
                { label: "Daily", value: "day" },
                { label: "Weekly", value: "week" },
                { label: "Monthly", value: "month" },
                { label: "Yearly", value: "year" },
              ]}
              triggerClassName={profileSelectTriggerClassName}
              triggerId={compensationIntervalId}
              value={field.value}
            />
          </div>
        )}
      />
      <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
        <FieldLabel htmlFor={salaryCurrencyId}>
          Compensation currency
        </FieldLabel>
        <ProfileInput
          id={salaryCurrencyId}
          maxLength={3}
          placeholder="USD or EUR"
          {...register("salaryCurrency")}
        />
        {!watch("salaryCurrency").trim() &&
        (watch("minimumSalaryUsd").trim() ||
          watch("targetSalaryUsd").trim()) ? (
          <p className="text-xs leading-5 text-(--warning-text)">
            Add a three-letter currency before relying on compensation matching.
          </p>
        ) : null}
      </div>
    </>
  );
}
