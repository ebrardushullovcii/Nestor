// @vitest-environment jsdom
import type { RawApplyControl } from "@nestor/contracts";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  personFieldEditsInPage,
  type PersonFieldCommand,
} from "./person-field-edits";

let listeners: Map<string, EventListener>;
const selector = "input,textarea,select";
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const collect = () => ({
  controls: [...document.querySelectorAll<HTMLInputElement>(selector)].map(
    (element, index): RawApplyControl => ({
      index,
      id: element.id,
      name: element.name,
      tagName: element.tagName.toLowerCase(),
      inputType: element.type,
      label: element.getAttribute("aria-label") ?? element.id,
      groupLabel: "",
      placeholder: element.placeholder,
      value: element.value,
      checked: element.checked,
      selectedOptionLabel: "",
      multiple: false,
      role: "",
      autocomplete: "",
      visible: true,
      disabled: false,
      readOnly: false,
      required: false,
      invalid: false,
      validationMessage: "",
      options: [],
    }),
  ),
});
const run = (command: PersonFieldCommand) =>
  personFieldEditsInPage(command, collect, selector);
function gesture(id: string, input: "key" | "pointer" = "key", trusted = true) {
  const element = document.getElementById(id)!;
  listeners.get(input === "key" ? "keydown" : "pointerdown")!({
    type: input === "key" ? "keydown" : "pointerdown",
    isTrusted: trusted,
    composedPath: () => [element],
  } as unknown as Event);
}
beforeEach(() => {
  vi.useFakeTimers();
  listeners = new Map();
  vi.spyOn(document, "addEventListener").mockImplementation(
    (name, callback) => {
      if (typeof callback === "function") listeners.set(name, callback);
    },
  );
  document.body.innerHTML =
    '<input id="name"><input id="email"><input type="file" id="resume"><section><input id="date" placeholder="Pick date..."><div role="option" id="day">15</div></section>';
  delete (globalThis as typeof globalThis & { __nestorPersonFields?: unknown })
    .__nestorPersonFields;
  run({ kind: "install" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("records only the field the person typed, with its exact value and page", () => {
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Synthetic Applicant";
  field("email").value = "site-autofill@example.test";
  const edits = run({ kind: "read" });
  expect(edits.map((row) => row.id)).toEqual(["name"]);
  expect(edits[0]?.personAnswer).toMatchObject({
    value: "Synthetic Applicant",
    checked: false,
    pageUrl: location.href,
  });
});

test("the serialized observer works in its isolated world, without page-writable state", () => {
  const loaded: unknown = runInNewContext(
    `(${personFieldEditsInPage.toString()})`,
    {
      document,
      location,
      Element,
      HTMLInputElement,
      HTMLTextAreaElement,
      HTMLSelectElement,
      Date,
      setTimeout,
    },
  );
  if (typeof loaded !== "function")
    throw new Error("Observer was not a function");
  const isolated = loaded as typeof personFieldEditsInPage;
  isolated({ kind: "install" }, collect, selector);
  // The regular world's forged state is irrelevant to the isolated observer.
  (
    globalThis as typeof globalThis & { __nestorPersonFields?: unknown }
  ).__nestorPersonFields = { run: () => collect().controls };
  expect(isolated({ kind: "read" }, collect, selector)).toEqual([]);
  isolated({ kind: "native", input: "key" }, collect, selector);
  gesture("name");
  field("name").value = "Person Name";
  expect(
    isolated({ kind: "read" }, collect, selector).map(
      (row) => row.personAnswer?.value,
    ),
  ).toEqual(["Person Name"]);
});

test("a file picker's resume autofill is not the person's answer to other fields", () => {
  run({ kind: "native", input: "pointer" });
  gesture("resume", "pointer");
  field("name").value = "Autofilled Name";
  field("email").value = "autofill@example.test";
  expect(run({ kind: "read" })).toEqual([]);
});

test("a native date choice changes the one focused input, even without a trusted input event", () => {
  field("date").focus();
  gesture("day", "pointer");
  field("date").value = "11/15/2026";
  // Native notification may arrive after the DOM event. The bounded pair still matches.
  run({ kind: "native", input: "pointer" });
  expect(
    run({ kind: "read" }).map((row) => [row.id, row.personAnswer?.value]),
  ).toEqual([["date", "11/15/2026"]]);
});

test("Nestor writes, untrusted events, and an unpaired field change grant nothing", () => {
  run({ kind: "automation", active: true });
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Agent Name";
  run({ kind: "automation", active: false });
  gesture("email", "key", false);
  field("email").value = "page-script@example.test";
  field("date").value = "11/15/2026";
  expect(run({ kind: "read" })).toEqual([]);
});

test("changed values, question identity and navigation invalidate an earlier attribution", () => {
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Person Name";
  expect(run({ kind: "read" })).toHaveLength(1);
  run({ kind: "automation", active: true });
  field("name").value = "Agent Name";
  run({ kind: "automation", active: false });
  expect(run({ kind: "read" })).toEqual([]);
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Person Again";
  expect(run({ kind: "read" })).toHaveLength(1);
  field("name").setAttribute("aria-label", "Reference name");
  expect(run({ kind: "read" })).toEqual([]);
  history.pushState({}, "", "#another-step");
  expect(run({ kind: "read" })).toEqual([]);
});
