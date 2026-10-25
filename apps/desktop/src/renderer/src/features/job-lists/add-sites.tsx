import { useEffect, useRef, useState } from "react";
import { Button } from "@renderer/components/ui/button";
import { ProfileTextarea } from "@renderer/features/job-finder/components/profile/profile-form-primitives";

/** Bulk input is a site write, independent of the profile form. */
export function AddSites(props: {
  onAdded?: (id: number | null) => void;
  alwaysOpen?: boolean;
  registerFlush?: (flush: (() => Promise<void>) | null) => void;
}) {
  const [open, setOpen] = useState(props.alwaysOpen ?? false);
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const add = async () => {
    if (!text.trim()) return;
    setPending(true);
    let hasInvalid = false;
    try {
      const result = await window.nestor.jobs.run("add_sites", { text });
      setMessage(
        `Added and turned on ${result.added} source${result.added === 1 ? "" : "s"}.` +
          (result.duplicates
            ? ` ${result.duplicates} ${result.duplicates === 1 ? "was" : "were"} already in your list.`
            : "") +
          (result.invalid.length
            ? ` Could not add: ${result.invalid.join(", ")}.`
            : ""),
      );
      if (result.added || result.duplicates) {
        setText(result.invalid.join("\n"));
        props.onAdded?.(result.firstAddedId);
      }
      hasInvalid = result.invalid.length > 0;
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "Could not add sources.",
      );
      throw reason;
    } finally {
      setPending(false);
    }
    if (hasInvalid)
      throw new Error("Fix the remaining source addresses before continuing.");
  };
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    props.registerFlush?.(() => addRef.current());
    return () => props.registerFlush?.(null);
  }, [props.registerFlush]);
  return (
    <div className="grid gap-3">
      {!props.alwaysOpen ? (
        <Button
          className="justify-self-start"
          onClick={() => setOpen(!open)}
          size="sm"
          type="button"
        >
          {open ? "Done adding" : "Add sources"}
        </Button>
      ) : null}
      {open ? (
        <div className="grid gap-2">
          <label className="text-sm font-medium" htmlFor="job-site-urls">
            Job site URLs
          </label>
          <ProfileTextarea
            id="job-site-urls"
            aria-label="Job site URLs"
            rows={4}
            value={text}
            placeholder="Paste careers or job-board URLs, one per line"
            onChange={(event) => {
              setText(event.target.value);
              setMessage(null);
            }}
          />
          <Button
            className="justify-self-start"
            disabled={!text.trim()}
            pending={pending}
            size="sm"
            type="button"
            onClick={() => {
              void add().catch(() => undefined);
            }}
          >
            Add and turn on
          </Button>
        </div>
      ) : null}
      {message ? (
        <p
          aria-live="polite"
          role="status"
          className="text-sm text-foreground-soft"
        >
          {message}
        </p>
      ) : null}
    </div>
  );
}
