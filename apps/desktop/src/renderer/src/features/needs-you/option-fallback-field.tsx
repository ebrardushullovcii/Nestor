import { Input } from "@renderer/components/ui/input";

export function OptionFallbackField(props: {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
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
