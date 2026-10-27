import type { RawApplyControl } from "@nestor/contracts";

export type PersonFieldCommand =
  | { kind: "install" }
  | { kind: "native"; input: "pointer" | "key" }
  | { kind: "automation"; active: boolean }
  | { kind: "read" };
export interface PersonFieldRead {
  controls: RawApplyControl[];
  credentialsSeen: boolean;
}
export const PERSON_FIELD_WORLD = 1007;

/** Serialized into an isolated world. The page cannot mint native-input grants. */
export function personFieldEditsInPage(
  command: PersonFieldCommand,
  collect: () => { controls: RawApplyControl[] },
  selector: string,
): PersonFieldRead {
  type Edit = {
    identity: string;
    answer: NonNullable<RawApplyControl["personAnswer"]>;
  };
  type Gesture = {
    field: Element;
    target: Element;
    identity: string;
    before: string;
    input: "pointer" | "key";
    popup: boolean;
    granted: boolean;
    sample: Edit | null;
  };
  type State = { run: (command: PersonFieldCommand) => PersonFieldRead };
  const world = globalThis as typeof globalThis & {
    __nestorPersonFields?: State;
  };
  if (!world.__nestorPersonFields) {
    let blocked = false,
      credentialsSeen = false;
    let native: "pointer" | "key" | null = null;
    let gesture: Gesture | null = null;
    const edits = new Map<Element, Edit>();
    const passwordElements = new WeakSet<Element>();
    const credential = (element: Element) => {
      const type = element.getAttribute("type")?.toLowerCase();
      if (type === "password") passwordElements.add(element);
      return (
        passwordElements.has(element) ||
        /^(?:current-password|new-password|one-time-code|username)$/iu.test(
          element.getAttribute("autocomplete") ?? "",
        )
      );
    };
    const inspect = (records: MutationRecord[]) => {
      for (const record of records) {
        if (
          record.type === "attributes" &&
          record.target instanceof Element &&
          ((record.attributeName === "type" &&
            record.oldValue?.toLowerCase() === "password") ||
            (record.attributeName === "autocomplete" &&
              /^(?:current-password|new-password|one-time-code|username)$/iu.test(
                record.oldValue ?? "",
              )))
        ) {
          credentialsSeen = true;
          if (record.attributeName === "type")
            passwordElements.add(record.target);
        }
        for (const node of [...record.addedNodes, ...record.removedNodes])
          if (
            node instanceof Element &&
            (credential(node) ||
              [...node.querySelectorAll("input")].some(credential))
          )
            credentialsSeen = true;
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document, {
      attributes: true,
      attributeOldValue: true,
      childList: true,
      subtree: true,
    });
    const checkCredentials = () => {
      inspect(observer.takeRecords());
      if ([...document.querySelectorAll("input")].some(credential))
        credentialsSeen = true;
      if (credentialsSeen) {
        edits.clear();
        gesture = null;
        native = null;
      }
      return credentialsSeen;
    };
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
      JSON.stringify([
        row.value,
        row.checked,
        row.selectedOptionLabel || row.value,
      ]);
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
    const commit = (current: Gesture) => {
      const sample = current.sample;
      if (!current.granted || !sample || blocked || checkCredentials()) return;
      const row = snapshot(current.field);
      if (
        row &&
        identity(row) === sample.identity &&
        value(row) ===
          JSON.stringify([
            sample.answer.value,
            sample.answer.checked,
            sample.answer.shownValue,
          ])
      )
        edits.set(current.field, sample);
      else edits.delete(current.field);
    };
    const begin = (event: Event) => {
      gesture = null;
      if (!event.isTrusted || blocked || checkCredentials()) {
        native = null;
        return;
      }
      const target = event.composedPath()[0];
      if (!(target instanceof Element)) return;
      const input = event.type === "keydown" ? "key" : "pointer";
      let field = target.closest("input,textarea,select");
      let popup = false;
      if (
        !editable(field) &&
        input === "pointer" &&
        editable(document.activeElement) &&
        target.closest(
          "[role=option],[role=gridcell],[role=listbox],[role=grid],[role=dialog],button",
        )
      ) {
        const focused = document.activeElement;
        if (
          focused.getAttribute("aria-controls") ||
          /date/iu.test(
            `${focused.getAttribute("placeholder")} ${focused.getAttribute("type")}`,
          )
        ) {
          for (
            let parent = focused.parentElement;
            parent && parent !== document.body;
            parent = parent.parentElement
          )
            if (parent.contains(target)) {
              if (
                parent.querySelectorAll(
                  "input:not([type=hidden]),textarea,select",
                ).length === 1
              ) {
                field = focused;
                popup = true;
              }
              break;
            }
        }
      }
      const row = editable(field) ? snapshot(field) : null;
      if (field && row)
        gesture = {
          field,
          target,
          identity: identity(row),
          before: value(row),
          input,
          popup,
          granted: native === input,
          sample: null,
        };
      native = null;
    };
    const sample = (event: Event, popupClick = false) => {
      const current = gesture;
      if (
        !current ||
        current.sample ||
        !event.isTrusted ||
        blocked ||
        checkCredentials()
      )
        return;
      const target = event.composedPath()[0];
      if (
        popupClick
          ? !current.popup || target !== current.target
          : target !== current.field
      )
        return;
      const row = snapshot(current.field);
      if (
        !row ||
        identity(row) !== current.identity ||
        value(row) === current.before
      )
        return;
      if (
        !popupClick &&
        current.input === "pointer" &&
        current.field instanceof HTMLInputElement &&
        !["checkbox", "radio", "range", "date", "month"].includes(
          current.field.type,
        )
      )
        return;
      // Freeze the value produced by this input, before page input handlers.
      // A popup's own click handler runs before this one-shot bubble listener.
      current.sample = {
        identity: current.identity,
        answer: {
          pageUrl: location.href,
          value: row.value,
          checked: row.checked,
          shownValue: row.selectedOptionLabel || row.value,
          recordedAt: new Date().toISOString(),
        },
      };
      commit(current);
    };
    document.addEventListener("pointerdown", begin, true);
    document.addEventListener("keydown", begin, true);
    document.addEventListener("input", (event) => sample(event), true);
    document.addEventListener("change", (event) => sample(event), true);
    document.addEventListener("click", (event) => sample(event, true));
    world.__nestorPersonFields = {
      run(command) {
        checkCredentials();
        if (command.kind === "automation") {
          blocked = command.active;
          native = null;
          gesture = null;
        } else if (command.kind === "native" && !blocked && !credentialsSeen) {
          if (gesture && !gesture.granted && gesture.input === command.input) {
            gesture.granted = true;
            commit(gesture);
          } else native = command.input;
        }
        const controls: RawApplyControl[] = [];
        if (command.kind === "read" && !credentialsSeen) {
          const fields = elements();
          for (const row of collect().controls) {
            const field = fields[row.index];
            if (!field) continue;
            const edit = edits.get(field);
            if (!edit) continue;
            if (
              edit.identity !== identity(row) ||
              value(row) !==
                JSON.stringify([
                  edit.answer.value,
                  edit.answer.checked,
                  edit.answer.shownValue,
                ])
            ) {
              edits.delete(field);
              continue;
            }
            controls.push({ ...row, personAnswer: edit.answer });
          }
        }
        return { controls, credentialsSeen };
      },
    };
  }
  return world.__nestorPersonFields.run(command);
}
