import { CheckboxField } from "../checkbox-field";

const EMPLOYMENT_TYPES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Temporary",
];

export function ProfileHoursField(props: {
  values: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const selected = new Set(props.values.map((value) => value.toLowerCase()));
  const options = [
    ...EMPLOYMENT_TYPES,
    ...props.values.filter(
      (value) =>
        !EMPLOYMENT_TYPES.some(
          (option) => option.toLowerCase() === value.toLowerCase(),
        ),
    ),
  ];
  return (
    <fieldset className="grid gap-2">
      <legend className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
        Hours
      </legend>
      <p className="text-sm leading-6 text-foreground-soft">
        Tick the kinds of work you want. Leave every box empty to see all of
        them.
      </p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {options.map((type) => (
          <CheckboxField
            key={type}
            label={type}
            checked={selected.has(type.toLowerCase())}
            onCheckedChange={(checked) =>
              props.onChange(
                checked
                  ? [...props.values, type]
                  : props.values.filter(
                      (value) => value.toLowerCase() !== type.toLowerCase(),
                    ),
              )
            }
          />
        ))}
      </div>
    </fieldset>
  );
}
