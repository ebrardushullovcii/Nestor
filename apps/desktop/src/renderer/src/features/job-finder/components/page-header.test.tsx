// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { PageHeader, PageHeaderStack, PageSubnav } from "./page-header";

describe("PageHeader", () => {
  it("puts the title, a one-line description and the actions on one row", () => {
    const view = render(
      <PageHeader
        actions={<button type="button">New search plan</button>}
        description="Reusable searches with their own roles, sources and schedule."
        title="Search plans"
      />,
    );

    const header = view.container.querySelector("[data-page-header]");
    expect(header?.tagName).toBe("HEADER");
    for (const token of [
      "flex",
      "min-h-8",
      "items-center",
      "justify-between",
    ]) {
      expect(header?.className).toContain(token);
    }
    // No grid switch and no stacked layout any more.
    expect(header?.className).not.toMatch(/grid|xl:/u);

    const heading = screen.getByRole("heading", { name: "Search plans" });
    expect(heading.className).toContain("shrink-0");
    expect(heading.className).not.toContain("max-w-[24ch]");

    const actions = view.container.querySelector("[data-page-header-actions]");
    expect(actions?.className).toContain("shrink-0");
    expect(header?.contains(actions as Node)).toBe(true);
    expect(
      screen.getByRole("button", { name: "New search plan" }),
    ).toBeTruthy();
  });

  it("keeps the description whole: one line beside the title, wrapped under it, never cut", () => {
    const description =
      "A long supporting sentence that would wrap onto a second line in a narrow window.";
    render(<PageHeader description={description} title="Needs you" />);

    const heading = screen.getByRole("heading", { name: "Needs you" });
    const text = screen.getByText(description);
    expect(text.className).not.toContain("truncate");
    expect(text.className).toContain("window-wide:whitespace-nowrap");
    expect(text.className).not.toContain("max-w-[68ch]");
    expect(text.getAttribute("title")).toBe(description);
    expect(heading.getAttribute("aria-describedby")).toBe(text.id);
  });

  it("drops the description under the title only below 1024px", () => {
    render(<PageHeader description="Plain page." title="Outcomes" />);

    const titleBlock = screen.getByRole("heading", {
      name: "Outcomes",
    }).parentElement;
    expect(titleBlock?.className).toContain("flex-col");
    expect(titleBlock?.className).toContain("window-wide:flex-row");
    expect(titleBlock?.className).toContain("window-wide:items-baseline");
  });

  it("omits the actions region when no actions are given", () => {
    const view = render(
      <PageHeader description="Plain page." title="Outcomes" />,
    );

    expect(
      view.container.querySelector("[data-page-header-actions]"),
    ).toBeNull();
  });
});

describe("PageHeaderStack", () => {
  it("owns exactly one bottom divider and the shared body seam", () => {
    const view = render(
      <PageHeaderStack
        description="Search your sources and review the strongest matches."
        title="Find jobs"
      />,
    );

    const stack = view.container.querySelector("[data-page-header-stack]");
    const dividers = view.container.querySelectorAll(
      "[data-page-header-divider]",
    );
    expect(dividers).toHaveLength(1);
    expect(stack?.className).toContain("mb-(--gap-page-header-body)");
    expect(dividers[0]?.className).toContain("border-b");
  });

  it("renders no status line when there is nothing to report", () => {
    const view = render(
      <PageHeaderStack
        description="Plain page."
        statusItems={[]}
        title="Applications"
      />,
    );

    expect(
      view.container.querySelector("[data-page-header-status]"),
    ).toBeNull();
  });

  it("places the status line under the title row and above the subnav", () => {
    const view = render(
      <MemoryRouter>
        <PageHeaderStack
          actions={<button type="button">Open tracker</button>}
          description="Track your applications and their hiring progress."
          statusItems={[
            {
              id: "holds",
              tone: "critical",
              text: "3 safeguard holds are pausing some work",
              action: {
                kind: "link",
                label: "Open Safeguards",
                to: "/job-finder/safeguards",
              },
            },
          ]}
          subnav={
            <div role="group" aria-label="Plan scope">
              scope
            </div>
          }
          title="Applications"
        />
      </MemoryRouter>,
    );

    const header = view.container.querySelector("[data-page-header]");
    const status = screen.getByRole("status");
    const subnav = view.container.querySelector("[data-page-header-subnav]");
    const actions = view.container.querySelector("[data-page-header-actions]");

    expect(status.hasAttribute("data-page-header-status")).toBe(true);
    expect(actions?.contains(status)).toBe(false);
    expect(
      (header?.compareDocumentPosition(status) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (status.compareDocumentPosition(subnav as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(subnav?.className).toContain("mt-(--gap-page-header-aux)");
    expect(screen.getByRole("link", { name: "Open Safeguards" })).toBeTruthy();
  });
});

describe("PageSubnav", () => {
  it("is a layout-only row that forwards semantics to its children", () => {
    const view = render(
      <PageSubnav aria-label="Find jobs workspace" role="group">
        <button aria-pressed type="button">
          Results
        </button>
      </PageSubnav>,
    );

    const subnav = view.container.querySelector("[data-page-subnav]");
    expect(subnav?.tagName).toBe("DIV");
    expect(subnav?.className).toContain("flex-wrap");
    expect(
      screen.getByRole("group", { name: "Find jobs workspace" }),
    ).toBeTruthy();
  });
});
