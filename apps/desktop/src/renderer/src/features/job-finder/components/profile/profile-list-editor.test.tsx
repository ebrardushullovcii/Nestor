// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseProfileLocationDraft,
  ProfileListEditor,
} from "./profile-list-editor";

describe("ProfileListEditor", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  function renderEditor(props?: {
    displayMode?: "chips" | "rows";
    onChange?: (values: string[]) => void;
    values?: readonly string[];
  }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileListEditor
          {...(props?.displayMode ? { displayMode: props.displayMode } : {})}
          label="Skills"
          onChange={props?.onChange ?? vi.fn()}
          placeholder="Add a skill"
          values={props?.values ?? []}
        />,
      );
    });
  }

  function typeIntoEditor(text: string) {
    const input = container?.querySelector("input");
    expect(input).toBeTruthy();

    act(() => {
      const valueDescriptor = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        "value",
      );
      const setValue = valueDescriptor?.set?.bind(input);
      setValue?.(text);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    return input as HTMLInputElement;
  }

  it("rests on the neutral panel border instead of an active accent", () => {
    renderEditor();

    const section = container?.querySelector("section");
    expect(section?.className).toContain("border-(--surface-panel-border)");
    expect(section?.className).not.toContain("-active-soft");
  });

  it("keeps the value tray mounted while empty so adding items cannot shift the layout", () => {
    renderEditor();

    const tray = [...(container?.querySelectorAll("section > div") ?? [])].find(
      (element) => element.className.includes("min-h-"),
    );
    expect(tray).toBeDefined();
    expect(tray?.textContent).toContain("No items added yet.");
    expect(tray?.querySelector("p")?.className).toContain("m-auto");
  });

  it("collapses the empty chips tray to roughly one control height", () => {
    renderEditor();

    const tray = [...(container?.querySelectorAll("section > div") ?? [])].find(
      (element) => element.className.includes("min-h-"),
    );
    expect(tray?.className).toContain("min-h-14");
    expect(tray?.className).not.toContain("min-h-[8.6rem]");
    expect(tray?.className).not.toContain("8.6rem");
  });

  it("collapses the empty rows tray instead of reserving the tall list height", () => {
    renderEditor({ displayMode: "rows" });

    const tray = [...(container?.querySelectorAll("section > div") ?? [])].find(
      (element) => element.className.includes("min-h-"),
    );
    expect(tray?.textContent).toContain("No items added yet.");
    expect(tray?.className).toContain("min-h-14");
    expect(tray?.className).not.toContain("min-h-46");
  });

  it("lets a populated chip tray grow instead of clipping rows", () => {
    renderEditor({ values: ["Figma", "React"] });

    const tray = [...(container?.querySelectorAll("section > div") ?? [])].find(
      (element) => element.className.includes("min-h-"),
    );
    expect(tray?.textContent).toContain("Figma");
    expect(tray?.textContent).not.toContain("No items added yet.");
    // The tray grows with its chips; the old 8.6rem floor left ~100px of
    // empty space under a single row.
    expect(tray?.className).toContain("min-h-16");
    expect(tray?.className).not.toContain("8.6rem");
    expect(tray?.className).not.toContain("overflow-auto");
  });

  it("lets a populated rows tray grow instead of clipping entries", () => {
    renderEditor({ displayMode: "rows", values: ["Figma", "React"] });

    const tray = [...(container?.querySelectorAll("section > div") ?? [])].find(
      (element) => element.className.includes("min-h-"),
    );
    expect(tray?.className).toContain("min-h-46");
    expect(tray?.className).not.toContain("max-h-46");
    expect(tray?.className).not.toContain("overflow-auto");
  });

  it("keeps a typed entry when the field is left without pressing Add", () => {
    // Guided setup saved a plan with no roles because the role typed into
    // this field was still uncommitted when "Save and continue" was clicked.
    const onChange = vi.fn();
    renderEditor({ onChange });

    const input = typeIntoEditor("QA Tester");

    act(() => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onChange).toHaveBeenCalledWith(["QA Tester"]);
    expect(input.value).toBe("");
  });

  it("does not add an empty entry when an untouched field is left", () => {
    const onChange = vi.fn();
    renderEditor({ onChange, values: ["React"] });

    const input = container?.querySelector("input");
    act(() => {
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps comma-delimited place details together and splits only semicolons or newlines", () => {
    expect(
      parseProfileLocationDraft(
        "Chicago, IL; Manchester, England\nPrishtina, Kosovo",
      ),
    ).toEqual([
      "Chicago, IL",
      "Manchester, England",
      "Prishtina, Kosovo",
    ]);
  });

  it("adds multiple locations without turning the region into another place", () => {
    const onChange = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileListEditor
          draftParser={parseProfileLocationDraft}
          label="Preferred locations"
          onChange={onChange}
          placeholder="Example: Austin, TX; Remote"
          values={[]}
        />,
      );
    });

    typeIntoEditor("Chicago, IL; Remote");
    const addButton = [...(container.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Add",
    );
    act(() => addButton?.click());

    expect(onChange).toHaveBeenCalledWith(["Chicago, IL", "Remote"]);
  });
});
