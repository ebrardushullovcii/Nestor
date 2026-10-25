import { useId } from "react";
import type { NeedsYouTask } from "@nestor/contracts";
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
  if (question.input === "boolean" || question.input === "choice") {
    const options =
      question.input === "boolean" ? ["Yes", "No"] : question.options;
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
