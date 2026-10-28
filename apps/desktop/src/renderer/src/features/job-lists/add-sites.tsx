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
  const [duplicateUrls, setDuplicateUrls] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const add = async () => {
    if (!text.trim()) return;
    setPending(true);
    let hasInvalid = false;
    try {
      const result = await window.nestor.jobs.run("add_sites", { text });
      setDuplicateUrls(result.duplicateUrls);
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
  // One address a line: the count tells a long paste arrived whole.
  const addresses = text.split("\n").filter((line) => line.trim()).length;
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    props.registerFlush?.(() => addRef.current());
    return () => props.registerFlush?.(null);
  }, [props.registerFlush]);
  const edit = (value: string) => {
    setText(value);
    setMessage(null);
    setDuplicateUrls([]);
  };
  const editRef = useRef(edit);
  editRef.current = edit;
  const box = useRef<HTMLTextAreaElement>(null);
  // Chromium types inserted text (dictation, an input method, automation) one
  // line at a time with a layout per line: 900 addresses held the window for
  // about 1.8 s. A paste is already one edit; insert typed lines in one too.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const insertLines = (event: InputEvent) => {
      if (event.inputType !== "insertText" || !event.data?.includes("\n"))
        return;
      event.preventDefault();
      element.setRangeText(
        event.data,
        element.selectionStart,
        element.selectionEnd,
        "end",
      );
      editRef.current(element.value);
    };
    element.addEventListener("beforeinput", insertLines);
    return () => element.removeEventListener("beforeinput", insertLines);
  }, [open]);
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
          {/* No spellcheck or wrapping: checking and laying out a paste of
              900 addresses froze the window for seconds. */}
          <ProfileTextarea
            ref={box}
            id="job-site-urls"
            aria-describedby="job-site-urls-count"
            aria-label="Job site URLs"
            rows={4}
            spellCheck={false}
            value={text}
            wrap="off"
            placeholder="Paste careers or job-board URLs, one per line"
            onChange={(event) => edit(event.target.value)}
          />
          <p
            className="text-(length:--text-small) text-foreground-soft tabular-nums"
            id="job-site-urls-count"
          >
            {addresses > 0
              ? `${addresses.toLocaleString()} address${addresses === 1 ? "" : "es"}`
              : null}
          </p>
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
      {duplicateUrls.length ? (
        <div className="grid gap-1">
          <label htmlFor="duplicate-site-urls" className="text-sm font-medium">
            Skipped duplicate URLs
          </label>
          <ProfileTextarea
            id="duplicate-site-urls"
            readOnly
            rows={Math.min(6, duplicateUrls.length)}
            value={duplicateUrls.join("\n")}
          />
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
