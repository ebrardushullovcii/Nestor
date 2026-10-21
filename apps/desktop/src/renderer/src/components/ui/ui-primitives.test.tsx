// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Count } from "./count";
import { Dialog } from "./dialog";
import { Disclosure } from "./disclosure";
import { Eyebrow } from "./eyebrow";
import { Input } from "./input";
import { Popover } from "./popover";
import { SegmentedControl } from "./segmented-control";
import { Select, SelectTrigger, SelectValue } from "./select";

// This project does not enable testing-library auto-cleanup, and three of the
// primitives here portal into document.body, so an un-torn-down render leaks
// into the next test's queries.
afterEach(() => {
  cleanup();
});

describe("Input size scale and disabled binding", () => {
  it("keeps the 44px field box by default and exposes the 32px toolbar box", () => {
    const { rerender } = render(<Input aria-label="Search" />);
    const field = screen.getByLabelText("Search");
    expect(field.className).toContain("h-11");
    expect(field.getAttribute("data-size")).toBe("default");

    rerender(<Input aria-label="Search" size="toolbar" />);
    const toolbar = screen.getByLabelText("Search");
    expect(toolbar.className).toContain("h-8");
    expect(toolbar.className).not.toContain("h-11");
    expect(toolbar.getAttribute("data-size")).toBe("toolbar");
  });

  it("paints disabled with the shared tokens instead of an opacity wash", () => {
    render(<Input aria-label="Search" disabled />);
    const field = screen.getByLabelText("Search");
    expect(field.className).not.toMatch(/disabled:opacity-(?!100\b)/);
    expect(field.className).toContain("disabled:border-(--disabled-border)");
    expect(field.className).toContain("disabled:bg-(--disabled-surface)");
    expect(field.className).toContain("disabled:text-(--disabled-foreground)");
    expect(field.className).toContain(
      "disabled:placeholder:text-(--disabled-foreground)",
    );
  });
});

describe("SelectTrigger size scale and disabled binding", () => {
  function renderTrigger(size?: "sm" | "toolbar" | "default") {
    render(
      <Select>
        <SelectTrigger aria-label="Sort" {...(size ? { size } : {})}>
          <SelectValue placeholder="Best match" />
        </SelectTrigger>
      </Select>,
    );
    return screen.getByLabelText("Sort");
  }

  it("exposes the shared toolbar box", () => {
    const trigger = renderTrigger("toolbar");
    expect(trigger.getAttribute("data-size")).toBe("toolbar");
    expect(trigger.className).toContain("data-[size=toolbar]:h-8");
    expect(trigger.className).toContain("data-[size=default]:h-11");
  });

  it("paints disabled with the shared tokens instead of an opacity wash", () => {
    const trigger = renderTrigger();
    expect(trigger.className).not.toMatch(/disabled:opacity-(?!100\b)/);
    expect(trigger.className).toContain("disabled:border-(--disabled-border)");
    expect(trigger.className).toContain("disabled:bg-(--disabled-surface)");
    expect(trigger.className).toContain(
      "disabled:text-(--disabled-foreground)",
    );
    expect(trigger.className).toContain(
      "disabled:data-[placeholder]:text-(--disabled-foreground)",
    );
  });
});

describe("SegmentedControl", () => {
  const options = [
    { value: "comfortable", label: "Comfortable" },
    { value: "compact", label: "Compact" },
    { value: "dense", label: "Dense", disabled: true },
  ] as const;

  function renderControl(onValueChange = vi.fn(), value = "comfortable") {
    render(
      <SegmentedControl
        label="Row density"
        onValueChange={onValueChange}
        options={options}
        value={value}
      />,
    );
    return onValueChange;
  }

  it("names the group and marks exactly one segment as the active one", () => {
    renderControl();
    expect(screen.getByRole("group", { name: "Row density" })).not.toBeNull();
    const pressed = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.textContent).toBe("Comfortable");
  });

  it("reports a new value once and never re-reports the active one", () => {
    const onValueChange = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("compact");

    fireEvent.click(screen.getByRole("button", { name: "Comfortable" }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("is keyboard operable: every segment is tabbable and arrows move focus past disabled ones", () => {
    renderControl();
    const comfortable = screen.getByRole("button", { name: "Comfortable" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(comfortable.getAttribute("tabindex")).toBeNull();
    expect(compact.getAttribute("tabindex")).toBeNull();

    comfortable.focus();
    fireEvent.keyDown(comfortable, { key: "ArrowRight" });
    expect(document.activeElement).toBe(compact);

    // "Dense" is disabled, so forward wraps back to the first enabled segment.
    fireEvent.keyDown(compact, { key: "ArrowRight" });
    expect(document.activeElement).toBe(comfortable);
  });
});

describe("Dialog", () => {
  function renderDialog(onClose = vi.fn(), open = true) {
    render(
      <Dialog
        description="What this dialog is for."
        onClose={onClose}
        open={open}
        title="Confirm change"
      >
        <button type="button">Inside</button>
      </Dialog>,
    );
    return onClose;
  }

  it("portals one scrim, one shell and exactly one close affordance", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Confirm change" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.closest("#root")).toBeNull();
    expect(
      document.querySelectorAll("[data-slot='dialog-close']"),
    ).toHaveLength(1);
    expect(dialog.parentElement?.className).toContain("bg-(--modal-scrim)");
    expect(dialog.parentElement?.className).toContain("z-[140]");
  });

  it("closes on Escape, on the scrim, and on the close affordance", () => {
    const onClose = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const dialog = screen.getByRole("dialog", { name: "Confirm change" });
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(3);

    // A click inside the shell is not a dismissal.
    fireEvent.click(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("restores focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog onClose={onClose} open title="Confirm change" />,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Confirm change" }),
    );

    rerender(<Dialog onClose={onClose} open={false} title="Confirm change" />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("renders nothing while closed", () => {
    renderDialog(vi.fn(), false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Popover", () => {
  it("renders the placement it is given without clamping it", () => {
    render(
      <Popover
        label="Saved views"
        open
        placement={{ top: 9000, left: 8000, width: 224, maxHeight: 4000 }}
      >
        <p>Body</p>
      </Popover>,
    );

    const popover = screen.getByRole("dialog", { name: "Saved views" });
    // The shared solver owns flip/shift/height. This shell must not quietly
    // re-clamp with a second floor.
    expect(popover.style.top).toBe("9000px");
    expect(popover.style.left).toBe("8000px");
    expect(popover.style.width).toBe("224px");
    expect(popover.style.maxHeight).toBe("4000px");
    expect(popover.className).toContain("z-[70]");
    expect(popover.className).toContain("rounded-(--radius-panel)");
    expect(popover.className).toContain("shadow-(--select-shadow)");
    expect(popover.closest("#root")).toBeNull();
  });

  it("renders nothing while closed", () => {
    render(
      <Popover label="Saved views" open={false} placement={{ top: 0, left: 0 }}>
        <p>Body</p>
      </Popover>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Disclosure", () => {
  it("toggles uncontrolled and reports the change once", () => {
    const onOpenChange = vi.fn();
    render(
      <Disclosure onOpenChange={onOpenChange} summary="Filters">
        <p>Body</p>
      </Disclosure>,
    );

    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("honours a controlled open state", () => {
    const { rerender } = render(
      <Disclosure open={false} summary="Filters">
        <p>Body</p>
      </Disclosure>,
    );
    const details = document.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);

    rerender(
      <Disclosure open summary="Filters">
        <p>Body</p>
      </Disclosure>,
    );
    expect((document.querySelector("details") as HTMLDetailsElement).open).toBe(
      true,
    );
  });
});

describe("Count", () => {
  it("never paints a zero or a negative count", () => {
    const { container, rerender } = render(<Count value={0} />);
    expect(container.querySelector("[data-slot='count']")).toBeNull();

    rerender(<Count value={-3} />);
    expect(container.querySelector("[data-slot='count']")).toBeNull();

    rerender(<Count value={Number.NaN} />);
    expect(container.querySelector("[data-slot='count']")).toBeNull();
  });

  it("renders one plain tabular figure inline and the marker only on the rail", () => {
    const { container, rerender } = render(<Count label="unread" value={13} />);
    const inline = container.querySelector(
      "[data-slot='count']",
    ) as HTMLElement;
    expect(inline.textContent).toContain("13");
    expect(inline.className).toContain("tabular-nums");
    expect(inline.className).toContain("bg-transparent");
    expect(inline.className).not.toContain("rounded-full");
    expect(screen.getByText("13 unread")).not.toBeNull();

    rerender(<Count value={13} variant="rail-marker" />);
    const marker = container.querySelector(
      "[data-slot='count']",
    ) as HTMLElement;
    expect(marker.getAttribute("data-variant")).toBe("rail-marker");
    expect(marker.className).toContain("rounded-full");
  });

  it("caps the rail marker at 99+ and keeps the full number readable", () => {
    const { container, rerender } = render(
      <Count value={678} variant="rail-marker" />,
    );
    const marker = container.querySelector(
      "[data-slot='count']",
    ) as HTMLElement;
    expect(marker.textContent).toContain("99+");
    expect(screen.getByText("678").className).toContain("sr-only");

    // The other variants keep the whole figure.
    rerender(<Count value={678} variant="pill" />);
    expect(
      (container.querySelector("[data-slot='count']") as HTMLElement)
        .textContent,
    ).toBe("678");
  });
});

describe("Eyebrow", () => {
  it("is a span and never a heading", () => {
    const { container } = render(<Eyebrow>Recommended next</Eyebrow>);
    const eyebrow = container.querySelector(
      "[data-slot='eyebrow']",
    ) as HTMLElement;
    expect(eyebrow.tagName).toBe("SPAN");
    expect(eyebrow.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(eyebrow.className).toContain("uppercase");
    expect(eyebrow.className).toContain("tracking-(--tracking-caps)");
    expect(eyebrow.className).toContain("text-(length:--text-eyebrow)");
  });
});
