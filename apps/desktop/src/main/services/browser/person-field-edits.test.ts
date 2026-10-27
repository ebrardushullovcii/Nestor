// @vitest-environment jsdom
import type { RawApplyControl } from "@nestor/contracts";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  personFieldEditsInPage,
  type PersonFieldCommand,
} from "./person-field-edits";

let listeners: Map<string, EventListener>;
const OriginalMutationObserver = MutationObserver;
const observers: MutationObserver[] = [];
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
      placeholder: element.getAttribute("placeholder") ?? "",
      value: element.value,
      checked: Boolean(element.checked),
      selectedOptionLabel:
        element instanceof HTMLSelectElement
          ? (element.selectedOptions[0]?.label ?? "")
          : "",
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
  personFieldEditsInPage(command, collect, selector).controls;
function input(id: string, type = "input", trusted = true) {
  const element = document.getElementById(id)!;
  listeners.get(type)!({
    type,
    isTrusted: trusted,
    composedPath: () => [element],
  } as unknown as Event);
}
function gesture(id: string, input: "key" | "pointer" = "key", trusted = true) {
  const element = document.getElementById(id)!;
  listeners.get(input === "key" ? "keydown" : "pointerdown")!({
    type: input === "key" ? "keydown" : "pointerdown",
    isTrusted: trusted,
    composedPath: () => [element],
  } as unknown as Event);
}
beforeEach(() => {
  vi.stubGlobal(
    "MutationObserver",
    class extends OriginalMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
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
  for (const observer of observers.splice(0)) observer.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("records only the field the person typed, with its exact value and page", () => {
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Synthetic Applicant";
  input("name");
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
      MutationObserver,
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
  expect(isolated({ kind: "read" }, collect, selector).controls).toEqual([]);
  isolated({ kind: "native", input: "key" }, collect, selector);
  gesture("name");
  field("name").value = "Person Name";
  input("name");
  expect(
    isolated({ kind: "read" }, collect, selector).controls.map(
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
  input("day", "click");
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
  input("name");
  expect(run({ kind: "read" })).toHaveLength(1);
  run({ kind: "automation", active: true });
  field("name").value = "Agent Name";
  run({ kind: "automation", active: false });
  expect(run({ kind: "read" })).toEqual([]);
  run({ kind: "native", input: "key" });
  gesture("name");
  field("name").value = "Person Again";
  input("name");
  expect(run({ kind: "read" })).toHaveLength(1);
  field("name").setAttribute("aria-label", "Reference name");
  expect(run({ kind: "read" })).toEqual([]);
  history.pushState({}, "", "#another-step");
  expect(run({ kind: "read" })).toEqual([]);
});

test.each(["typed", "clicked"])(
  "a site change after the person %s is never adopted",
  (action) => {
    run({ kind: "native", input: action === "typed" ? "key" : "pointer" });
    gesture("name", action === "typed" ? "key" : "pointer");
    if (action === "typed") {
      field("name").value = "Person value";
      input("name");
    }
    field("name").value = "Site autofill";
    vi.advanceTimersByTime(150);
    expect(run({ kind: "read" })).toEqual([]);
    field("name").value = "Person value";
    expect(run({ kind: "read" })).toEqual([]);
  },
);

test("a dependent list cannot relabel the option the person selected", () => {
  const select = document.createElement("select");
  select.id = "salary";
  select.innerHTML =
    '<option value="">Choose</option><option value="band1">90000</option>';
  document.body.append(select);
  run({ kind: "native", input: "key" });
  gesture("salary");
  select.value = "band1";
  input("salary");
  expect(run({ kind: "read" })[0]?.personAnswer?.shownValue).toBe("90000");
  select.options[1]!.text = "120000";
  expect(run({ kind: "read" })).toEqual([]);
  select.options[1]!.text = "90000";
  expect(run({ kind: "read" })).toEqual([]);
});

test.each([
  "shown password",
  "removed password",
  "one-time code",
  "credential identifier",
])(
  "%s taints the whole document, including previously edited fields",
  (shape) => {
    run({ kind: "native", input: "key" });
    gesture("name");
    field("name").value = "Person Name";
    input("name");
    expect(run({ kind: "read" })).toHaveLength(1);
    const secret = document.createElement("input");
    secret.type = shape.includes("password") ? "password" : "text";
    document.body.append(secret);
    if (shape === "shown password") secret.type = "text";
    if (shape === "removed password") secret.remove();
    if (shape === "one-time code") {
      secret.type = "text";
      secret.autocomplete = "one-time-code";
    }
    if (shape === "credential identifier") {
      secret.type = "text";
      secret.autocomplete = "username";
    }
    const read = personFieldEditsInPage({ kind: "read" }, collect, selector);
    expect(read).toEqual({ controls: [], credentialsSeen: true });
    secret.remove();
    run({ kind: "native", input: "key" });
    gesture("date");
    field("date").value = "11/15/2026";
    input("date");
    expect(run({ kind: "read" })).toEqual([]);
  },
);
