// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  JobFinderGlobalSearch,
  JobFinderGlobalSearchDialog,
} from "./job-finder-global-search";

const sampleEntries = [
  {
    href: "/job-finder/discovery?job=one",
    id: "one",
    kind: "job" as const,
    metadata: ["TypeScript", "remote"],
    subtitle: "Acme · Remote",
    title: "Platform Engineer",
  },
  {
    href: "/job-finder/discovery?job=two",
    id: "two",
    kind: "job" as const,
    metadata: ["TypeScript", "hybrid"],
    subtitle: "Globex · Hybrid",
    title: "Senior Platform Engineer",
  },
  {
    href: "/job-finder/settings?asset=resume",
    id: "resume",
    kind: "document" as const,
    metadata: ["resume"],
    subtitle: "PDF",
    title: "Elian CV",
  },
];

function typeQuery(query: string) {
  fireEvent.change(
    screen.getByRole("combobox", {
      name: "Search your workspace",
    }),
    {
      target: { value: query },
    },
  );
}

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  // jsdom does not implement scrolling; highlight-follow assertions inspect
  // this mock instead.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoViewMock,
  });
});

afterEach(() => {
  scrollIntoViewMock.mockClear();
});

afterEach(cleanup);

describe("JobFinderGlobalSearchDialog", () => {
  let appRoot: HTMLDivElement;

  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function DialogHarness(props: {
    onClose: ReturnType<typeof vi.fn>;
    onNavigate: ReturnType<typeof vi.fn>;
    startOpen?: boolean;
  }) {
    const [open, setOpen] = useState(props.startOpen ?? true);
    return (
      <div>
        <button onClick={() => setOpen(true)} type="button">
          Open search
        </button>
        {open ? (
          <JobFinderGlobalSearchDialog
            entries={sampleEntries}
            focusRequest={1}
            onClose={(...args) => {
              props.onClose(...args);
              setOpen(false);
            }}
            onNavigate={props.onNavigate}
          />
        ) : null}
      </div>
    );
  }

  function renderDialog(
    overrides: Partial<{
      onClose: ReturnType<typeof vi.fn>;
      onNavigate: ReturnType<typeof vi.fn>;
      startOpen: boolean;
    }> = {},
  ) {
    const onClose = overrides.onClose ?? vi.fn();
    const onNavigate = overrides.onNavigate ?? vi.fn();

    const view = render(
      <DialogHarness
        onClose={onClose}
        onNavigate={onNavigate}
        {...(overrides.startOpen !== undefined
          ? { startOpen: overrides.startOpen }
          : {})}
      />,
      { container: appRoot },
    );

    return { ...view, onClose, onNavigate };
  }

  it("renders an accessible modal that focuses and selects the search field", () => {
    renderDialog();

    const dialog = screen.getByRole("dialog", {
      name: "Search your workspace",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
    );
    expect(
      screen.getByText("Everything saved on this device is searchable."),
    ).toBeTruthy();
    expect(appRoot.getAttribute("inert")).toBe("");
    expect(appRoot.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps modal results in normal flow so the dialog grows before it scrolls", () => {
    renderDialog();

    typeQuery("typescript");
    const results = document.querySelector<HTMLElement>(
      "[data-job-finder-global-search-results]",
    );

    expect(results?.className).toContain("relative");
    expect(results?.className).not.toContain("absolute");
    expect(screen.getByText("2 results")).toBeTruthy();
  });

  it("keeps Tab cycling inside the dialog", () => {
    renderDialog();

    typeQuery("typescript");
    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Tab" });

    expect(document.activeElement).not.toBe(document.body);
    const dialog = screen.getByRole("dialog", {
      name: "Search your workspace",
    });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Tab",
      shiftKey: true,
    });
    expect(
      screen
        .getByRole("dialog", { name: "Search your workspace" })
        .contains(document.activeElement),
    ).toBe(true);
  });

  it("closes through Escape while restoring focus to the opener", async () => {
    const { onClose } = renderDialog({ startOpen: false });

    const opener = screen.getByRole("button", { name: "Open search" });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", {
          name: "Search your workspace",
        }),
      ),
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "Search your workspace",
        }),
      ).toBeNull(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
    expect(appRoot.hasAttribute("inert")).toBe(false);
    expect(appRoot.hasAttribute("aria-hidden")).toBe(false);
  });

  it("closes through a named control while restoring focus to the opener", async () => {
    const { onClose } = renderDialog({ startOpen: false });
    const opener = screen.getByRole("button", { name: "Open search" });
    opener.focus();
    fireEvent.click(opener);

    const closeButton = await screen.findByRole("button", {
      name: "Close search",
    });
    closeButton.focus();
    fireEvent.click(closeButton);

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "Search your workspace",
        }),
      ).toBeNull(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(opener);
  });

  it("restores the exact root isolation attributes on unmount", () => {
    appRoot.setAttribute("inert", "persisted");
    appRoot.setAttribute("aria-hidden", "false");

    const { unmount } = renderDialog();
    expect(appRoot.getAttribute("inert")).toBe("");
    expect(appRoot.getAttribute("aria-hidden")).toBe("true");

    unmount();

    expect(appRoot.getAttribute("inert")).toBe("persisted");
    expect(appRoot.getAttribute("aria-hidden")).toBe("false");
  });

  it("closes after navigating so owners never stack overlays", () => {
    const onNavigate = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onClose, onNavigate });

    typeQuery("resume");
    const resumeOption = screen.getAllByRole("option", { name: /Elian CV/ })[0];
    expect(resumeOption).toBeTruthy();
    fireEvent.click(resumeOption as HTMLElement);

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ href: "/job-finder/settings?asset=resume" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();
  });
});

describe("JobFinderGlobalSearch", () => {
  it("searches local metadata, groups results, and navigates through the owner callback", () => {
    const onNavigate = vi.fn();
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={onNavigate} />,
    );

    typeQuery("typescript");
    expect(screen.getByText("2 results")).toBeTruthy();
    expect(
      document.querySelector<HTMLElement>(
        "[data-job-finder-global-search-results]",
      )?.className,
    ).toContain("absolute");
    fireEvent.click(
      screen.getByRole("option", { name: /Platform Engineer Acme/i }),
    );
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "/job-finder/discovery?job=one",
        id: "one",
        kind: "job",
      }),
    );
  });

  it("supports arrow-key highlighting with Enter selection through the combobox pattern", () => {
    const onNavigate = vi.fn();
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={onNavigate} />,
    );
    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });

    typeQuery("platform engineer");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);
    expect(
      screen
        .getByRole("option", { name: /Platform Engineer Acme/i })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-1$/);
    expect(
      screen
        .getByRole("option", { name: /Senior Platform Engineer/i })
        .getAttribute("aria-selected"),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        href: "/job-finder/discovery?job=one",
        id: "one",
      }),
    );
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses the popup with Escape and reopens on the next query change", () => {
    const onNavigate = vi.fn();
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={onNavigate} />,
    );
    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });

    typeQuery("typescript");
    expect(screen.getByText("2 results")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByText("2 results")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect((input as HTMLInputElement).value).toBe("typescript");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onNavigate).not.toHaveBeenCalled();

    typeQuery("typescript ");
    expect(screen.getByText("2 results")).toBeTruthy();
  });

  it("keeps result options out of the Tab order while staying click-selectable", () => {
    const onNavigate = vi.fn();
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={onNavigate} />,
    );

    typeQuery("typescript");
    for (const option of screen.getAllByRole("option")) {
      expect(option.getAttribute("tabindex")).toBe("-1");
      expect(option.tagName).toBe("BUTTON");
    }
  });

  it("ignores navigation and selection keys during IME composition", () => {
    const onNavigate = vi.fn();
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={onNavigate} />,
    );
    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });

    typeQuery("typescript");

    // Composition-phase ArrowDown must not move the active option...
    fireEvent.keyDown(input, {
      isComposing: true,
      key: "ArrowDown",
      keyCode: 229,
    });
    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-option-0$/);

    // ...and a composing Enter must never commit a selection.
    fireEvent.keyDown(input, {
      isComposing: true,
      key: "Enter",
      keyCode: 229,
    });
    expect(onNavigate).not.toHaveBeenCalled();

    // A 229 keydown without the flag is still composition.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("brings the keyboard-highlighted option into view with nearest scrolling", () => {
    render(
      <JobFinderGlobalSearch entries={sampleEntries} onNavigate={vi.fn()} />,
    );

    typeQuery("engineer");
    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "ArrowDown" },
    );
    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "ArrowDown" },
    );

    const secondOption = screen.getByRole("option", {
      name: /Senior Platform Engineer/,
    });
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "nearest" });
    expect(scrollIntoViewMock.mock.contexts).toContain(secondOption);
  });

  it("shows a zero-results state for queries without matches", () => {
    render(<JobFinderGlobalSearch entries={[]} onNavigate={vi.fn()} />);

    typeQuery("zzzz");
    expect(screen.getByText("0 results")).toBeTruthy();
    expect(screen.getByText(/Nothing in your saved jobs/i));
  });

  it("does not search on one noisy character", () => {
    render(<JobFinderGlobalSearch entries={[]} onNavigate={vi.fn()} />);
    typeQuery("a");
    expect(screen.queryByText(/local records match/i)).toBeNull();
  });

  it("wraps long result labels and exposes their complete names", () => {
    const longTitle = "ApplicationTitleWithoutAnyWordBreaksAtAll";
    const longSubtitle = "CompanyWithoutAnyWordBreaks · RemoteWithoutBreaks";
    render(
      <JobFinderGlobalSearch
        entries={[
          {
            href: "/job-finder/applications/one",
            id: "one",
            kind: "application",
            metadata: ["long"],
            subtitle: longSubtitle,
            title: longTitle,
          },
        ]}
        onNavigate={vi.fn()}
      />,
    );

    typeQuery("long");
    const result = screen.getByRole("option", {
      name: /ApplicationTitleWithoutAnyWordBreaksAtAll/,
    });
    const title = result.querySelector("strong");
    const subtitle = result.querySelector("span");
    expect(result.className).toContain("min-w-0");
    expect(title?.className).toContain("break-words");
    expect(title?.getAttribute("title")).toBe(longTitle);
    expect(subtitle?.className).toContain("break-words");
    expect(subtitle?.getAttribute("title")).toBe(longSubtitle);
  });
});
