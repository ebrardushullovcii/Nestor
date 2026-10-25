import { useEffect, useState } from "react";
import { Button } from "@renderer/components/ui/button";

const LANGUAGES = [
  "Albanian",
  "Arabic",
  "Chinese",
  "Dutch",
  "English",
  "French",
  "German",
  "Italian",
  "Japanese",
  "Korean",
  "Portuguese",
  "Spanish",
];

export function ResumeWorkspaceLanguagePicker(props: {
  language: string | null;
  writtenLanguage: string | null;
  listingLanguage?: string | null;
  disabled: boolean;
  /**
   * Sits inside the studio header row instead of on a row of its own; the
   * "translates this draft" hint becomes the field's tooltip.
   */
  inline?: boolean;
  onWrite: (language: string | null) => void;
}) {
  const [requestedLanguage, setRequestedLanguage] = useState<
    string | null | undefined
  >(undefined);
  // A failed rewrite keeps the previous written draft. Keep the person's
  // request visible until a newly written draft arrives.
  useEffect(() => {
    setRequestedLanguage(undefined);
  }, [props.writtenLanguage]);
  const language =
    requestedLanguage === undefined ? props.language : requestedLanguage;
  const [custom, setCustom] = useState(false);
  const [customLanguage, setCustomLanguage] = useState("");
  const listingLanguage = props.listingLanguage ?? null;
  const choices =
    language && !LANGUAGES.includes(language)
      ? [...LANGUAGES, language]
      : LANGUAGES;
  return (
    // Sits between the header panel and the status strip: the same 8px gap
    // the other rows here use, and inset to line up with the header's text.
    <div
      className={
        props.inline
          ? "flex flex-wrap items-center gap-2 text-sm"
          : "mt-2 flex flex-wrap items-center gap-2 px-5 text-sm"
      }
      data-resume-language-picker
    >
      <label
        className="flex items-center gap-2"
        {...(props.inline
          ? { title: "Choosing a language translates this draft." }
          : {})}
      >
        Resume language
        <select
          aria-label="Resume language"
          className="h-8 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-2.5 text-xs outline-none focus-visible:border-(--field-focus-border)"
          disabled={props.disabled}
          value={custom ? "custom" : (language ?? "")}
          onChange={(event) => {
            if (event.target.value === "custom") {
              setCustom(true);
              return;
            }
            setCustom(false);
            setRequestedLanguage(event.target.value || null);
            props.onWrite(event.target.value || null);
          }}
        >
          <option value="">
            Listing language
            {listingLanguage ? ` — ${listingLanguage}` : ""}
          </option>
          {choices.map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
          <option value="custom">Another language…</option>
        </select>
      </label>
      {custom ? (
        <>
          <input
            aria-label="Another resume language"
            className="h-8 rounded-(--radius-field) border border-(--field-border) bg-(--field) px-2.5 text-xs outline-none focus-visible:border-(--field-focus-border)"
            disabled={props.disabled}
            value={customLanguage}
            onChange={(event) => setCustomLanguage(event.target.value)}
            placeholder="Language name"
          />
          <Button
            disabled={props.disabled || !customLanguage.trim()}
            onClick={() => {
              setRequestedLanguage(customLanguage.trim());
              props.onWrite(customLanguage.trim());
              setCustom(false);
            }}
            size="sm"
            type="button"
          >
            Write in this language
          </Button>
        </>
      ) : null}
      <span
        className={
          props.inline ? "sr-only" : "text-xs text-foreground-muted"
        }
      >
        Choosing a language translates this draft.
      </span>
    </div>
  );
}
