/** Self-contained DOM reader, shared by page observation and selection checks. */
export function collectCustomComboboxStates(
  elements: Element[],
  selected: number[],
): Array<
  readonly [
    number,
    { selectedOptionLabel: string; compositeVisible: boolean } | null,
  ]
> {
  const wanted = new Set(selected);
  return elements.map((element, index) => {
    if (!wanted.has(index)) return [index, null] as const;
    const root = element.closest(
      "[class*='__control'], [class*='-control'], .select-shell, [class*='select-shell']",
    );
    const drawn = (node: Element) =>
      !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== "hidden" &&
      getComputedStyle(node).opacity !== "0";
    const compositeVisible = !!root && drawn(root);
    const value = root?.querySelector<HTMLElement>(
      "[class*='__single-value'], [class*='-singleValue'], [class*='single-value'], [role='option'][aria-selected='true']",
    );
    let selectedOptionLabel =
      compositeVisible && value && drawn(value) ? value.innerText.trim() : "";
    if (selectedOptionLabel && value) {
      // A collapsed phone picker can show a country flag and code while its
      // menu spelled out the country. Recover only the flag's actual region;
      // a shared calling code never identifies the country by itself.
      const regions = new Set(
        [value, ...Array.from(value.querySelectorAll("[class]"))]
          .filter(drawn)
          .flatMap((node) => (node.getAttribute("class") ?? "").split(/\s+/u))
          .map((name) => /^iti__([a-z]{2})$/iu.exec(name)?.[1]?.toUpperCase())
          .filter((region): region is string => !!region),
      );
      if (regions.size === 1) {
        const region = [...regions][0]!;
        try {
          const name = new Intl.DisplayNames(["en"], { type: "region" }).of(
            region,
          );
          if (
            name &&
            name !== region &&
            !selectedOptionLabel.toLowerCase().startsWith(name.toLowerCase())
          )
            selectedOptionLabel = `${name} ${selectedOptionLabel}`;
        } catch {
          // An unrecognised flag supplies no country evidence.
        }
      }
    }
    return [index, { selectedOptionLabel, compositeVisible }] as const;
  });
}
