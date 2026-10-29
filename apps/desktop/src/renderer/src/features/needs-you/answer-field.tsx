import { useId, useState } from "react";
import {
  formatMultiChoiceAnswer,
  parseMultiChoiceAnswer,
  type NeedsYouTask,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";

export function AnswerField(props: {
  question: Pick<NeedsYouTask, "prompt" | "input" | "options">;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const { question, value, onChange, disabled } = props;
  if (question.input === "multi_choice")
    return <MultiChoices key={question.prompt} {...props} />;
  if (question.input === "boolean" || question.input === "choice") {
    const options =
      question.input === "boolean" && question.options.length === 0
        ? ["Yes", "No"]
        : question.options;
    if (options.length > 8)
      return (
        <SearchableChoices key={question.prompt} {...props} options={options} />
      );
    return (
      <fieldset disabled={disabled} className="grid gap-3">
        <legend className="mb-3 font-medium">{question.prompt}</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((option) => (
            <Button
              key={option}
              type="button"
              aria-pressed={value === option}
              variant={value === option ? "secondary" : "outline"}
              onClick={() => onChange(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="grid gap-3">
      <label className="font-medium" htmlFor={id}>
        {question.prompt}
      </label>
      {question.input === "number" ? (
        <Input
          id={id}
          disabled={disabled}
          type="number"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Textarea
          id={id}
          disabled={disabled}
          className="min-h-36"
          maxLength={20000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </div>
  );
}

function SearchableChoices(
  props: Parameters<typeof AnswerField>[0] & { options: string[] },
) {
  const id = useId(),
    [search, setSearch] = useState("");
  const shown = props.options.filter((option) =>
    option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <fieldset disabled={props.disabled} className="grid gap-3">
      <legend className="mb-3 font-medium">{props.question.prompt}</legend>
      <label htmlFor={id} className="text-sm">
        Search options
      </label>
      <Input
        id={id}
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search the form’s options"
        aria-controls={`${id}-choices`}
      />
      <p className="text-sm text-muted-foreground" role="status">
        {shown.length} of {props.options.length} options
        {props.value ? ` · Selected: ${props.value}` : ""}
      </p>
      <div
        id={`${id}-choices`}
        role="radiogroup"
        aria-label={props.question.prompt}
        className="max-h-64 overflow-y-auto rounded-md border p-2"
      >
        {shown.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-muted"
          >
            <input
              type="radio"
              name={`${id}-answer`}
              value={option}
              checked={props.value === option}
              onChange={() => props.onChange(option)}
            />
            <span>{option}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            No matching options.
          </p>
        )}
      </div>
    </fieldset>
  );
}

/** "Select all that apply": the answer is every ticked option, in the form's order. */
function MultiChoices(props: Parameters<typeof AnswerField>[0]) {
  const id = useId(),
    [search, setSearch] = useState("");
  const { options } = props.question;
  const chosen = parseMultiChoiceAnswer(props.value, options) ?? [];
  const searchable = options.length > 8;
  const shown = options.filter((option) =>
    option.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );
  const toggle = (option: string, checked: boolean) => {
    const next = checked
      ? [...chosen, option]
      : chosen.filter((value) => value !== option);
    props.onChange(next.length ? formatMultiChoiceAnswer(next, options) : "");
  };
  // Forms usually say it already; say it once.
  const hint = [
    /all that apply/iu.test(props.question.prompt)
      ? ""
      : "Select all that apply.",
    chosen.length ? `${chosen.length} selected.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <fieldset disabled={props.disabled} className="grid gap-3">
      <legend className="mb-3 font-medium">{props.question.prompt}</legend>
      <p className="text-sm text-foreground-soft" id={`${id}-hint`}>
        {hint}
      </p>
      {searchable ? (
        <>
          <label htmlFor={`${id}-search`} className="text-sm">
            Search options
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search the form’s options"
            aria-controls={`${id}-choices`}
          />
        </>
      ) : null}
      <div
        id={`${id}-choices`}
        aria-describedby={`${id}-hint`}
        className={
          searchable
            ? "grid max-h-64 gap-1 overflow-y-auto rounded-md border p-2"
            : "grid gap-1"
        }
      >
        {shown.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-muted"
          >
            <input
              type="checkbox"
              value={option}
              checked={chosen.includes(option)}
              onChange={(event) => toggle(option, event.target.checked)}
            />
            <span>{option}</span>
          </label>
        ))}
        {shown.length === 0 && (
          <p className="p-2 text-sm text-muted-foreground">
            No matching options.
          </p>
        )}
      </div>
    </fieldset>
  );
}
