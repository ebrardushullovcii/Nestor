// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {} from "@nestor/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COUNT_VARIANT_CLASS } from "@renderer/components/ui/count";
import { cn } from "@renderer/lib/utils";

import {
  DESTINATION_COUNT_INLINE_LAYOUT_CLASS,
  JobFinderShell,
  SHELL_HEADER_CLASS,
  SHELL_SIDEBAR_CLASS,
} from "./job-finder-shell";
import {
  HEADER_TOOL_COUNT_ATTENTION_CLASS,
  HEADER_TOOL_COUNT_CLASS,
  HEADER_TOOL_COUNT_SLOT_CLASS,
  formatHeaderToolCount,
} from "./header-tool";

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
 * One navigation model at every width: the sidebar (a list, or the icon rail
 * below 1200px) is the only destination list. There is no top-tab strip.
 */
const COUNTED_STAGES = {
  found: 2,
  hidden: 0,
  shortlisted: 0,
  resume: 0,
  applied: 2,
};

function renderShell(stageCounts = COUNTED_STAGES, needsYouCount = 1) {
  return render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <JobFinderShell
        needsYouCount={needsYouCount}
        platform="win32"
        stageCounts={stageCounts}
      >
        <div>Current screen</div>
      </JobFinderShell>
    </MemoryRouter>,
  );
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
    const attentionBadge = needsYou.querySelector(
      '[data-header-tool-count="attention"]',
    );

    // Inventory is the shared `<Count variant="inline">` figure in the row's
    // fixed-width right column; attention is a warning-coloured pill pinned
    // to the header tool's corner, out of the flow.
    expect(inventoryBadge?.className).toBe(
      cn(COUNT_VARIANT_CLASS.inline, DESTINATION_COUNT_INLINE_LAYOUT_CLASS),
    );
    expect(attentionBadge?.className).toBe(
      cn(HEADER_TOOL_COUNT_CLASS, HEADER_TOOL_COUNT_ATTENTION_CLASS),
    );
    expect(attentionBadge?.textContent).toBe("1");
    // Pinned to the bell's corner, inside the button, so it takes no room
    // and keeps clear of the window's top edge.
    const slot = attentionBadge?.parentElement;
    expect(slot?.className).toBe(HEADER_TOOL_COUNT_SLOT_CLASS);
    expect(HEADER_TOOL_COUNT_SLOT_CLASS).toMatch(/\babsolute\b/);
    expect(slot?.parentElement?.nextElementSibling?.textContent).toBe(
      "Needs you",
    );
    expect(needsYou.getAttribute("aria-label")).toMatch(
      /^Needs you: \d+ unresolved$/,
    );
    // Both counts stay visual-only; the accessible name carries them.
    expect(inventoryBadge?.getAttribute("aria-hidden")).toBe("true");
    expect(attentionBadge?.parentElement?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("draws no count at zero and keeps no room for one, and shortens big counts without changing them", () => {
    renderShell(undefined, 0);
    const needsYou = screen.getByRole("button", { name: /^Needs you/ });
    // Every tool is its natural width: no reserved slot, no extra padding.
    expect(
      needsYou.querySelector(`[class="${HEADER_TOOL_COUNT_SLOT_CLASS}"]`),
    ).toBeNull();
    expect(needsYou.querySelector("[data-header-tool-count]")).toBeNull();
    expect(needsYou.className).not.toMatch(/px-\[/);
    expect(formatHeaderToolCount(7)).toBe("7");
    expect(formatHeaderToolCount(1234)).toBe("1,234");
    expect(formatHeaderToolCount(9999)).toBe("9,999");
    expect(formatHeaderToolCount(12_345)).toBe("12.3k");
    expect(formatHeaderToolCount(123_456)).toBe("123k");
  });

  it("names what a sidebar count counts, exactly, outside the name", () => {
    renderShell({
      found: 12_345,
      hidden: 0,
      shortlisted: 2,
      resume: 3,
      applied: 1,
    });
    const sidebar = getSidebar();
    const row = (name: string) => within(sidebar).getByRole("button", { name });
    expect(row("Find jobs").getAttribute("aria-description")).toBe(
      "12,345 found",
    );
    expect(row("Shortlisted").getAttribute("aria-description")).toBe(
      "2 to review",
    );
    expect(row("Applications").getAttribute("aria-description")).toBe("1 sent");
  });

  it("never renders a badge at zero", () => {
    renderShell({
      found: 0,
      hidden: 0,
      shortlisted: 0,
      resume: 0,
      applied: 0,
    });

    const counts = Array.from(
      getSidebar().querySelectorAll<HTMLElement>("span.tabular-nums"),
    );
    for (const count of counts) {
      expect(count.textContent?.trim()).not.toBe("0");
    }
  });

  it("offers no top-tab navigation at any width", () => {
    renderShell();
    expect(
      screen.queryByRole("navigation", { name: "Job Finder sections" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /^More/ })).toBeNull();
  });
});

describe("shell chrome ownership", () => {
  it("uses shared tokens for the sticky shell edges and the search scrim", () => {
    // The header and sidebar edges are hairlines, not control boundaries.
    expect(SHELL_HEADER_CLASS).toContain("border-(--border-subtle)");
    expect(SHELL_SIDEBAR_CLASS).toContain("border-(--border-subtle)");
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
