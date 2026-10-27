import { sameSavedChoice } from "@nestor/contracts";
import { Input } from "@renderer/components/ui/input";

/** Why a fallback cannot be saved with this answer, or null when it can. */
export function fallbackProblem(
  answer: string,
  fallback: string | null,
): string | null {
  if (fallback === null) return null;
  if (!fallback.trim()) return "Enter the fallback option.";
  if (answer.trim().length > 300)
    return "A fallback works with a short answer that a list can offer.";
  if (sameSavedChoice(answer, fallback))
    return "The fallback must be a different choice from your answer.";
  return null;
}

export function OptionFallbackField(props: {
  answer: string;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  const problem = fallbackProblem(props.answer, props.value);
  return (
    <fieldset disabled={props.disabled} className="grid gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={props.value !== null}
          onChange={(event) => props.onChange(event.target.checked ? "" : null)}
        />
        Use a fallback when my answer is missing from a list
      </label>
      {props.value !== null ? (
        <>
          <label className="grid gap-2">
            Fallback option
            <Input
              maxLength={300}
              value={props.value}
              onChange={(event) => props.onChange(event.target.value)}
            />
          </label>
          {problem && props.value.trim() ? (
            <p className="text-xs text-foreground-muted" role="status">
              {problem}
            </p>
          ) : null}
          <p className="text-xs text-foreground-muted">
            Try your answer first, then this fallback. If neither is offered,
            skip the application and close its tab. You can still open the job
            and apply yourself.
          </p>
        </>
      ) : null}
    </fieldset>
  );
}
