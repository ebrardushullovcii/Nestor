// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
} from "@nestor/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COUNT_VARIANT_CLASS } from "@renderer/components/ui/count";
import { cn } from "@renderer/lib/utils";

import {
  COMPACT_NAV_PILL_CLASS,
  DESTINATION_COUNT_ATTENTION_CLASS,
  DESTINATION_COUNT_INLINE_LAYOUT_CLASS,
  JobFinderShell,
  SHELL_HEADER_CLASS,
  SHELL_SIDEBAR_CLASS,
} from "./job-finder-shell";

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function readSource(relativePath: string): string {
  return readFileSync(path.join(RENDERER_ROOT, relativePath), "utf8");
}

const SHELL_SOURCE = readSource(
  "features/job-finder/components/job-finder-shell.tsx",
);
const PAGE_SOURCE = readSource("pages/job-finder-page.tsx");

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

/**
 * The shell renders the wide sidebar and the compact top navigation from the
 * same definitions and hides the wrong one with CSS, so both are in the DOM at
 * every width in jsdom. Width therefore only decides which surface a user
 * sees; the class strings this file compares are the ones that would paint at
 * 1439px (compact navigation) and 1441px (sidebar).
 */
const COUNTED_STAGES = {
  found: 2,
  hidden: 0,
  shortlisted: 0,
  resume: 0,
  applied: 2,
};

function renderShell(stageCounts = COUNTED_STAGES) {
  return render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <JobFinderShell
        needsYouCount={1}
        platform="win32"
        stageCounts={stageCounts}
       
      >
        <div>Current screen</div>
      </JobFinderShell>
    </MemoryRouter>,
  );
}

function getCompactNavigation(): HTMLElement {
  return screen.getByRole("navigation", { name: "Job Finder sections" });
}

function getSidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Job Finder sidebar" });
}

beforeEach(() => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      window: {
        close: vi.fn().mockResolvedValue(undefined),
        getControlsState: vi.fn().mockResolvedValue(windowControlsState),
        minimize: vi.fn().mockResolvedValue(windowControlsState),
        onControlsStateChange: vi.fn(() => vi.fn()),
        toggleMaximize: vi.fn().mockResolvedValue(windowControlsState),
      },
    },
    writable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shell destination counts", () => {
  it("renders a visibly distinct treatment for attention counts", () => {
    renderShell();

    const sidebar = getSidebar();
    const findJobs = within(sidebar).getByRole("button", {
      name: /^Find jobs/,
    });
    const needsYou = screen.getByRole("button", { name: /^Needs you:/ });

    const inventoryBadge = findJobs.querySelector('[data-slot="count"]');
    const attentionBadge = needsYou.querySelector("span.tabular-nums");

    // The shape is the shared `<Count variant="pill">` primitive; the shell
    // adds only its own row placement. Composed the same way the component
    // does, so the exact painted string is still pinned.
    expect(inventoryBadge?.className).toBe(
      cn(COUNT_VARIANT_CLASS.pill, DESTINATION_COUNT_INLINE_LAYOUT_CLASS),
    );
    expect(attentionBadge?.className).toBe(DESTINATION_COUNT_ATTENTION_CLASS);
    expect(inventoryBadge?.className).not.toBe(attentionBadge?.className);

    // A bare number always means inventory, so the attention count also
    // carries a noun rather than standing alone beside the destination name.
    expect(attentionBadge?.textContent).toContain("unresolved");
    expect(needsYou.getAttribute("aria-label")).toMatch(
      /^Needs you: \d+ unresolved$/,
    );
    // The inventory count stays visual-only; the destination name is the sole
    // announced content.
    expect(inventoryBadge?.getAttribute("aria-hidden")).toBe("true");
  });

  it("never renders a badge at zero", () => {
    renderShell({
      found: 0,
      hidden: 0,
      shortlisted: 0,
      resume: 0,
      applied: 0,
    });

    for (const root of [getSidebar(), getCompactNavigation()]) {
      const counts = Array.from(
        root.querySelectorAll<HTMLElement>("span.tabular-nums"),
      );
      for (const count of counts) {
        expect(count.textContent?.trim()).not.toBe("0");
      }
    }
    // The lone default plan is not a count worth a badge either.
    expect(
      within(getSidebar())
        .queryByRole("button", { name: /^Search plans/ })
        ?.querySelector("span.tabular-nums"),
    ).toBeFalsy();
  });

  it("paints one identical count class at 1439px and 1441px", () => {
    renderShell();

    // 1439px paints the compact top navigation; 1441px paints the sidebar.
    const compactCount = within(getCompactNavigation())
      .getByRole("button", { name: /^Applications/ })
      .querySelector("span.tabular-nums");
    const wideCount = within(getSidebar())
      .getByRole("button", { name: /^Applications/ })
      .querySelector("span.tabular-nums");

    expect(compactCount?.textContent).toBe(wideCount?.textContent);
    // COMP-07: the same count used to be a plain number at 1441 and a filled
    // pill at 1439 — one number, two shapes, one breakpoint apart.
    expect(compactCount?.className).toBe(wideCount?.className);
    expect(compactCount?.className).toBe(
      cn(COUNT_VARIANT_CLASS.pill, DESTINATION_COUNT_INLINE_LAYOUT_CLASS),
    );
  });

  it("gives the More trigger the same pill class as its neighbours", () => {
    renderShell();

    const navigation = getCompactNavigation();
    const moreButton = within(navigation).getByRole("button", {
      name: /^More/,
    });
    const neighbour = within(navigation).getByRole("button", {
      name: /^Find jobs/,
    });

    for (const token of COMPACT_NAV_PILL_CLASS.split(/\s+/)) {
      expect(moreButton.className).toContain(token);
      expect(neighbour.className).toContain(token);
    }
    expect(moreButton.className).not.toContain("bg-(--surface-panel-raised)");
    expect(moreButton.className).not.toContain("min-h-10");
  });
});

describe("shell chrome ownership", () => {

  it("uses shared tokens for the sticky shell edges and the search scrim", () => {
    expect(SHELL_HEADER_CLASS).toContain(
      "border-(--surface-panel-shell-border)",
    );
    expect(SHELL_SIDEBAR_CLASS).toContain(
      "border-(--surface-panel-shell-border)",
    );
    // Class usage only: a docblock may still name the retired dilution to
    // explain why it was retired.
    for (const source of [SHELL_SOURCE, PAGE_SOURCE]) {
      expect(source).not.toMatch(/border-[a-z]+ border-border\/15/);
    }

    const globalSearchSource = readSource(
      "features/job-finder/components/job-finder-global-search.tsx",
    );
    expect(globalSearchSource).not.toContain("bg-black/40");
    expect(globalSearchSource).toContain("bg-(--modal-scrim)");
  });

  it("declares one route-section gap token on the route wrapper", () => {
    renderShell();

    const container = document.querySelector<HTMLElement>(
      "[data-job-finder-route-container]",
    );
    expect(container).toBeTruthy();
    expect(container?.style.getPropertyValue("--gap-route-section")).toBe(
      "var(--gap-card)",
    );
  });
});
