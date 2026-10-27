import type { RawApplyControl } from "@nestor/contracts";

export type PersonFieldCommand =
  | { kind: "install" }
  | { kind: "native"; input: "pointer" | "key" }
  | { kind: "automation"; active: boolean }
  | { kind: "read" };
export const PERSON_FIELD_WORLD = 1007;

/** Serialized into an isolated world. The page cannot mint native-input grants. */
export function personFieldEditsInPage(
  command: PersonFieldCommand,
  collect: () => { controls: RawApplyControl[] },
  selector: string,
): RawApplyControl[] {
  type Gesture = {
    field: Element;
    identity: string;
    before: string;
    at: number;
    input: "pointer" | "key";
    granted: boolean;
  };
  type State = { run: (command: PersonFieldCommand) => RawApplyControl[] };
  const world = globalThis as typeof globalThis & {
    __nestorPersonFields?: State;
  };
  if (!world.__nestorPersonFields) {
    let blocked = false;
    let native: { at: number; input: "pointer" | "key" } | null = null;
    const gestures: Gesture[] = [];
    const edits = new Map<
      Element,
      { identity: string; answer: NonNullable<RawApplyControl["personAnswer"]> }
    >();
    const elements = () => {
      const result: Element[] = [];
      const visit = (root: Document | ShadowRoot) => {
        result.push(...root.querySelectorAll(selector));
        for (const element of root.querySelectorAll("*"))
          if (element.shadowRoot) visit(element.shadowRoot);
      };
      visit(document);
      return result;
    };
    const snapshot = (field: Element) =>
      collect().controls.find((row) => row.index === elements().indexOf(field));
    const identity = (row: RawApplyControl) =>
      JSON.stringify([
        location.href,
        row.tagName,
        row.inputType,
        row.id,
        row.name,
        row.label,
        row.groupLabel,
        row.scopeKey,
      ]);
    const value = (row: RawApplyControl) =>
      JSON.stringify([row.value, row.checked]);
    const editable = (
      field: Element | null,
    ): field is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
      ((field instanceof HTMLInputElement &&
        !["file", "password", "hidden", "submit", "button"].includes(
          field.type,
        )) ||
        field instanceof HTMLTextAreaElement ||
        field instanceof HTMLSelectElement) &&
      !field.disabled &&
      !("readOnly" in field && field.readOnly);
    const flush = () => {
      if (blocked) return;
      for (const gesture of gestures) {
        if (!gesture.granted || Date.now() - gesture.at > 1000) continue;
        const row = snapshot(gesture.field);
        if (
          !row ||
          identity(row) !== gesture.identity ||
          value(row) === gesture.before
        )
          continue;
        edits.set(gesture.field, {
          identity: gesture.identity,
          answer: {
            pageUrl: location.href,
            value: row.value,
            checked: row.checked,
            recordedAt: new Date().toISOString(),
          },
        });
      }
    };
    const gesture = (event: Event) => {
      if (!event.isTrusted || blocked) return;
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      const input = event.type === "keydown" ? "key" : "pointer";
      let field = target.closest("input,textarea,select");
      // A date/choice popup commonly leaves its one input focused. Never
      // attribute a file picker's autofill of other fields to that gesture.
      if (
        !editable(field) &&
        input === "pointer" &&
        editable(document.activeElement)
      ) {
        const focused = document.activeElement;
        const popup = target.closest(
          "[role=option],[role=gridcell],[role=listbox],[role=grid],[role=dialog],button",
        );
        if (
          popup &&
          (focused.getAttribute("aria-controls") ||
            /date/iu.test(
              `${focused.getAttribute("placeholder")} ${focused.getAttribute("type")}`,
            ))
        ) {
          for (
            let parent = focused.parentElement;
            parent && parent !== document.body;
            parent = parent.parentElement
          ) {
            if (parent.contains(target)) {
              if (
                parent.querySelectorAll(
                  "input:not([type=hidden]),textarea,select",
                ).length === 1
              )
                field = focused;
              break;
            }
          }
        }
      }
      if (!editable(field)) return;
      const row = snapshot(field);
      if (!row) return;
      const at = Date.now();
      gestures.push({
        field,
        identity: identity(row),
        before: value(row),
        at,
        input,
        granted:
          !!native &&
          native.input === input &&
          at - native.at >= 0 &&
          at - native.at < 250,
      });
      if (gestures.length > 8) gestures.shift();
      native = null;
      setTimeout(flush, 0);
      setTimeout(flush, 150);
    };
    document.addEventListener("pointerdown", gesture, true);
    document.addEventListener("keydown", gesture, true);
    world.__nestorPersonFields = {
      run(command) {
        if (command.kind === "automation") {
          if (command.active) flush();
          blocked = command.active;
          native = null;
          gestures.length = 0;
        } else if (command.kind === "native") {
          if (blocked) return [];
          native = { at: Date.now(), input: command.input };
          const recent = gestures.findLast(
            (g) =>
              !g.granted &&
              g.input === command.input &&
              Date.now() - g.at < 250,
          );
          if (recent) {
            recent.granted = true;
            native = null;
            flush();
          }
        } else if (command.kind === "read") {
          flush();
          const fields = elements();
          return collect().controls.flatMap((row) => {
            const edit = edits.get(fields[row.index]!);
            return edit &&
              edit.identity === identity(row) &&
              value(row) ===
                JSON.stringify([edit.answer.value, edit.answer.checked])
              ? [{ ...row, personAnswer: edit.answer }]
              : [];
          });
        }
        return [];
      },
    };
  }
  return world.__nestorPersonFields.run(command);
}
