// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useForm } from "react-hook-form";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  createKnownJobSourceTargetsForFixtures,
  evaluateProfileSetupReadiness,
  JobSearchPreferencesSchema,
  type JobSearchPreferences,
} from "@nestor/contracts";
import { LockedScreenLayout } from "../../locked-screen-layout";
import {
  buildSearchPreferencesPayload,
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import type { DiscoveryTargetEditorValue } from "../../../lib/job-finder-types";
import { ProfileSetupTargetingStep } from "./profile-setup-step-sections";

afterEach(cleanup);

const profile = CandidateProfileSchema.parse({
  id: "candidate_setup_sources_catalog",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  email: "alex@example.com",
  baseResume: {
    id: "resume_setup_sources_catalog",
    fileName: "alex.pdf",
    uploadedAt: "2026-07-16T09:00:00.000Z",
    extractionStatus: "ready",
  },
  workEligibility: {},
  professionalSummary: {},
  targetRoles: [],
  locations: [],
  skills: [],
  experiences: [],
  education: [],
  certifications: [],
  links: [],
  projects: [],
  spokenLanguages: [],
});

const baselinePreferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

// True first-run shape: exactly what createEmptyJobFinderRepositoryState()
// seeds through contracts, so tests exercise the real fresh seed.
const freshSeedPreferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: {
    historyLimit: 5,
    targets: createKnownJobSourceTargetsForFixtures(),
  },
});
const freshSeedEditorTargets =
  createSearchPreferencesEditorValues(freshSeedPreferences).discoveryTargets;

function createCatalogTarget(
  index: number,
  overrides: Partial<DiscoveryTargetEditorValue> = {},
): DiscoveryTargetEditorValue {
  const sourceNumber = index.toString().padStart(3, "0");

  return {
    id: `catalog_target_${sourceNumber}`,
    label: `Board ${sourceNumber}`,
    startingUrl: `https://jobs-${index}.example.com/openings`,
    enabled: false,
    adapterKind: "auto",
    customInstructions: "",
    instructionStatus: "missing",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  };
}

function createCatalogTargets(count = 40): DiscoveryTargetEditorValue[] {
  return Array.from({ length: count }, (_, index) =>
    createCatalogTarget(index + 1, {
      ...(index === 16 ? { label: "Mercury Greenhouse board" } : {}),
    }),
  );
}

function assertIsHTMLElement(
  value: Element | null,
  message: string,
): HTMLElement {
  if (!(value instanceof HTMLElement)) {
    throw new Error(message);
  }
  return value;
}

function assertDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function SetupCatalogHarness(props: {
  baselinePreferences?: JobSearchPreferences;
  targets?: DiscoveryTargetEditorValue[];
}) {
  const baseline = props.baselinePreferences ?? baselinePreferences;
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: {
      ...createSearchPreferencesEditorValues(baseline),
      discoveryTargets: props.targets ?? createCatalogTargets(),
    },
  });
  const watchedDiscoveryTargets = preferencesForm.watch("discoveryTargets");
  // Same save path the step footer uses: readiness must move only when the
  // shared payload builder accepts the current draft.
  const savedPreferencesResult = buildSearchPreferencesPayload(baseline, {
    ...createSearchPreferencesEditorValues(baseline),
    discoveryTargets: watchedDiscoveryTargets,
  });
  const discoveryReady = savedPreferencesResult.payload
    ? evaluateProfileSetupReadiness(profile, savedPreferencesResult.payload)
        .hasDiscoverySource
    : false;

  return (
    <>
      <ProfileSetupTargetingStep
        nextStep="narrative"
        onSaveAndGoToStep={() => undefined}
        preferencesForm={preferencesForm}
        profileForm={profileForm}
        renderFooter={() => null}
      />
      <output data-discovery-source-ready={String(discoveryReady)}>
        {discoveryReady ? "discovery ready" : "discovery blocked"}
      </output>
    </>
  );
}

function getDiscoveryReady(): boolean {
  const output = document.querySelector("output");

  return output?.getAttribute("data-discovery-source-ready") === "true";
}

describe("ProfileSetupTargetingStep guided source catalog", () => {
  beforeAll(() => {
    // Deterministic pagination: the component's rAF-driven focus jump runs
    // synchronously instead of depending on jsdom frame timing.
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("presents saved sources that are all off and enables one explicitly", () => {
    render(
      <SetupCatalogHarness
        baselinePreferences={freshSeedPreferences}
        targets={freshSeedEditorTargets}
      />,
    );

    expect(screen.getByText("6 sources")).toBeTruthy();
    expect(screen.getByText("0 of 6 sources enabled for search")).toBeTruthy();
    // Starter sources exist but are all disabled: the step warns once, at its
    // top, with a jump to the list; the list does not say it a second time.
    expect(
      screen.queryByText(
        "All 6 saved sources are turned off. Enable at least one source below so Job Finder has somewhere to search.",
      ),
    ).toBeNull();
    const jumpCta = screen.getByRole("button", {
      name: "Show job sources to enable",
    });
    expect(jumpCta).toBeTruthy();
    expect(screen.getByText(/Saved job sources are still off/i)).toBeTruthy();
    const firstUsableSourceToggle = screen.getByRole("checkbox", {
      name: "Include Indeed in searches",
    });
    const scrollSpy = vi.fn();
    firstUsableSourceToggle.scrollIntoView = scrollSpy;
    const focusSpy = vi.spyOn(firstUsableSourceToggle, "focus");
    fireEvent.click(jumpCta);
    expect(scrollSpy).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    const kosovaRowCandidate = screen.getByText("KosovaJob").closest("article");
    expect(kosovaRowCandidate).toBeTruthy();
    const kosovaRow = assertIsHTMLElement(
      kosovaRowCandidate,
      "Expected KosovaJob row to be an HTMLElement",
    );
    expect(
      within(kosovaRow).getByText(
        "Public regional job board that is usually readable without an account.",
      ),
    ).toBeTruthy();
    expect(within(kosovaRow).queryByText("Disabled")).toBeNull();
    expect(
      within(kosovaRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(screen.getByText(/usually requires signing in/i)).toBeTruthy();
    expect(getDiscoveryReady()).toBe(false);

    expect(
      within(kosovaRow)
        .getByRole("checkbox", {
          name: "Include KosovaJob in searches",
        })
        .getAttribute("data-profile-setup-source-enable"),
    ).toBeTruthy();

    fireEvent.click(
      within(kosovaRow).getByRole("checkbox", {
        name: "Include KosovaJob in searches",
      }),
    );

    // The checkbox is the state; no badge repeats it.
    expect(within(kosovaRow).queryByText("Enabled")).toBeNull();
    expect(
      within(kosovaRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("1 of 6 sources enabled for search")).toBeTruthy();
    expect(screen.queryByText(/Enable at least one source below/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show job sources to enable" }),
    ).toBeNull();
    for (const label of ["Wellfound", "LinkedIn Jobs"]) {
      const row = screen.getByText(label).closest("article") as HTMLElement;
      expect(row.textContent).not.toContain("Disabled");
      expect(
        within(row)
          .getByRole("checkbox", { name: /^Include / })
          .getAttribute("aria-checked"),
      ).toBe("false");
    }
    expect(getDiscoveryReady()).toBe(true);
  });

  it("enables a starter source under sticky footer chrome without crashing", () => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    Element.prototype.scrollIntoView = vi.fn();

    render(
      <LockedScreenLayout
        bottomContent={<button type="button">Save and continue</button>}
        topContent={<div>Guided setup</div>}
      >
        <SetupCatalogHarness
          baselinePreferences={freshSeedPreferences}
          targets={freshSeedEditorTargets}
        />
      </LockedScreenLayout>,
    );

    const jumpCta = screen.getByRole("button", {
      name: "Show job sources to enable",
    });
    fireEvent.click(jumpCta);

    const wellfoundRow = assertIsHTMLElement(
      screen.getByText("Wellfound").closest("article"),
      "Expected Wellfound row to be an HTMLElement",
    );
    fireEvent.click(
      within(wellfoundRow).getByRole("checkbox", {
        name: "Include Wellfound in searches",
      }),
    );

    expect(
      within(wellfoundRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Show job sources to enable" }),
    ).toBeNull();
    expect(getDiscoveryReady()).toBe(true);
    expect(
      document.querySelector("[data-locked-screen-bottom-content]"),
    ).toBeTruthy();
  });

  it("scrolls the source list with responsive header margins before claiming focus on page change", () => {
    render(<SetupCatalogHarness />);

    const rawListHeading = document.getElementById(
      "profile-setup-job-sources-list-heading",
    );
    expect(rawListHeading).not.toBeNull();
    const listHeading = assertIsHTMLElement(
      rawListHeading,
      "Expected profile-setup-job-sources-list-heading to be an HTMLElement",
    );

    // Own synchronous frame mock: the suite-wide beforeAll spy is restored
    // by afterEach, so later tests must not rely on it.
    const rafSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });

    const scrollSpy = vi.fn();
    listHeading.scrollIntoView = scrollSpy;
    const focusSpy = vi.fn();
    listHeading.focus = focusSpy;

    // 40 catalog targets at a 25-row page size yield two pages.
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    rafSpy.mockRestore();

    // The reveal scrolls first through the shared responsive margins, then
    // claims focus without letting the browser perform any jump of its own.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({
      behavior: "auto",
      block: "start",
    });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    const scrollOrder = assertDefined(
      scrollSpy.mock.invocationCallOrder[0],
      "Expected scrollSpy invocationCallOrder[0] to be defined",
    );
    const focusOrder = assertDefined(
      focusSpy.mock.invocationCallOrder[0],
      "Expected focusSpy invocationCallOrder[0] to be defined",
    );
    expect(scrollOrder).toBeLessThan(focusOrder);
    expect(listHeading.className).toContain("scroll-mt-4");
    expect(listHeading.className).toContain("sm:scroll-mt-[8.25rem]");
    // The one-row header starts at the named `xl` breakpoint, which Tailwind
    // emits after `sm`, so it wins there; a plain arbitrary `min-[…]` token
    // would lose to the still-matching `sm:scroll-mt-[8.25rem]`.
    expect(listHeading.className).toContain("xl:scroll-mt-[4.5rem]");
    expect(listHeading.className).not.toContain(
      "min-[1440px]:scroll-mt-[4.5rem]",
    );
  });

  it("finds a known catalog entry by search and enables exactly that source explicitly", async () => {
    const { container } = render(<SetupCatalogHarness />);

    expect(getDiscoveryReady()).toBe(false);
    expect(screen.getByText("0 of 40 sources enabled for search")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "mercury" },
    });
    await waitFor(() =>
      expect(screen.getByText("1 of 40 sources")).toBeTruthy(),
    );

    const mercuryRowCandidate = screen
      .getByText("Mercury Greenhouse board")
      .closest("article");
    expect(mercuryRowCandidate).toBeTruthy();
    const mercuryRow = assertIsHTMLElement(
      mercuryRowCandidate,
      "Expected Mercury Greenhouse board row to be an HTMLElement",
    );
    expect(
      within(mercuryRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("false");

    fireEvent.click(
      within(mercuryRow).getByRole("checkbox", {
        name: "Include Mercury Greenhouse board in searches",
      }),
    );

    expect(
      within(mercuryRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The same control now reports the state instead of flipping its label.
    expect(
      within(mercuryRow)
        .getByRole("checkbox", {
          name: "Include Mercury Greenhouse board in searches",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(screen.getByText("1 of 40 sources enabled for search")).toBeTruthy();
    expect(getDiscoveryReady()).toBe(true);
    expect(container.textContent).not.toContain("Board 010 Enabled");
  });

  it("keeps every catalog entry disabled through search, paging, and editing", async () => {
    const { container } = render(
      <SetupCatalogHarness targets={createCatalogTargets(30)} />,
    );
    const enabledStatus = () => screen.getByText(/sources enabled for search/);

    expect(enabledStatus().textContent).toBe(
      "0 of 30 sources enabled for search",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
      target: { value: "board" },
    });
    expect(await screen.findByText("30 sources")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(enabledStatus().textContent).toBe(
        "0 of 30 sources enabled for search",
      ),
    );
    for (const card of Array.from(
      container.querySelectorAll("[data-profile-setup-source-card]"),
    )) {
      expect(card.textContent).not.toContain("Disabled");
      expect(
        card
          .querySelector("[data-profile-setup-source-enable]")
          ?.getAttribute("aria-checked"),
      ).toBe("false");
    }

    fireEvent.click(screen.getByRole("button", { name: "Edit Board 026" }));
    expect(
      container.querySelector("#profile-setup-source-url-catalog_target_026"),
    ).toBeTruthy();
    expect(enabledStatus().textContent).toBe(
      "0 of 30 sources enabled for search",
    );
    expect(getDiscoveryReady()).toBe(false);
  });

  it("adds a manual URL fallback that is ready to search straight away", async () => {
    render(<SetupCatalogHarness targets={[]} />);

    expect(
      screen.getByText(
        /Add an employer’s careers page or a job board you already use/,
      ),
    ).toBeTruthy();
    // With nothing saved, adding a site is the step: the form is already open,
    // so there is no button to open it, and Cancel closes it.
    expect(
      document.querySelector("[data-profile-setup-manual-source-form]"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Add a source URL manually" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      document.querySelector("[data-profile-setup-manual-source-form]"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Add a source URL manually" }),
    );

    const addButton = screen.getByRole("button", { name: "Add and turn on" });
    expect(addButton.hasAttribute("disabled")).toBe(true);

    const urlInput = screen.getByLabelText("Careers or job-board URL");
    fireEvent.change(urlInput, {
      target: { value: "example.com/careers" },
    });
    expect(
      await screen.findByText("Enter a complete http or https URL."),
    ).toBeTruthy();
    expect(urlInput.getAttribute("aria-invalid")).toBe("true");
    expect(addButton.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("Source name (optional)"), {
      target: { value: "Acme careers" },
    });
    fireEvent.change(urlInput, {
      target: { value: "https://acme.example/careers" },
    });
    expect(addButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(addButton);

    // The form stays open for the next address: adding a second site used to
    // take a press on "Add a source URL manually" first.
    expect(
      document.querySelector("[data-profile-setup-manual-source-form]"),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-profile-setup-source-added]")?.textContent,
    ).toContain("Added Acme careers and turned it on.");
    expect(
      screen.getByLabelText<HTMLInputElement>("Careers or job-board URL").value,
    ).toBe("");

    const acmeRowCandidate = screen
      .getByText("Acme careers", { selector: "article *" })
      .closest("article");
    expect(acmeRowCandidate).toBeTruthy();
    const acmeRow = assertIsHTMLElement(
      acmeRowCandidate,
      "Expected Acme careers row to be an HTMLElement",
    );
    // Adding a site is choosing it: it arrives switched on so the step is
    // finishable, and the same row still offers an explicit way to turn it off.
    expect(
      within(acmeRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(getDiscoveryReady()).toBe(true);

    fireEvent.click(
      within(acmeRow).getByRole("checkbox", {
        name: "Include Acme careers in searches",
      }),
    );

    expect(
      within(acmeRow)
        .getByRole("checkbox", { name: /^Include / })
        .getAttribute("aria-checked"),
    ).toBe("false");
    expect(getDiscoveryReady()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Done adding" }));
    expect(
      document.querySelector("[data-profile-setup-manual-source-form]"),
    ).toBeNull();
  });

  it("adds a second site with one press because the address form stays open", () => {
    render(<SetupCatalogHarness targets={[]} />);

    const urlInput = () =>
      screen.getByLabelText<HTMLInputElement>("Careers or job-board URL");
    fireEvent.change(urlInput(), {
      target: { value: "http://127.0.0.1:47950/board/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));
    fireEvent.change(urlInput(), {
      target: { value: "http://127.0.0.1:47950/greenhouse/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));

    expect(
      screen.queryByRole("button", { name: "Add a source URL manually" }),
    ).toBeNull();
    expect(document.querySelectorAll("article").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(getDiscoveryReady()).toBe(true);
  });

  it("splits a multiline clipboard paste into twelve separately enabled sources", () => {
    render(<SetupCatalogHarness targets={[]} />);
    const urls = Array.from(
      { length: 12 },
      (_, index) => `https://source-${index}.example.test/jobs`,
    );
    const input = screen.getByLabelText<HTMLInputElement>(
      "Careers or job-board URL",
    );
    fireEvent.paste(input, {
      clipboardData: { getData: () => urls.join("\n") },
    });
    expect(input.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));
    expect(screen.getByText("12 sources")).toBeTruthy();
    expect(screen.getByText(/Added 12 sources and turned them on/)).toBeTruthy();
    const cards = Array.from(
      document.querySelectorAll("[data-profile-setup-source-card]"),
    );
    expect(cards).toHaveLength(12);
    for (const [index, url] of urls.entries())
      expect(cards[index]?.textContent).toContain(new URL(url).host);
    // Every site is on, so no "12 of 12 enabled" line repeats it.
    expect(screen.queryByText(/sources enabled for search/)).toBeNull();
  });

  it("rejects a multiline paste containing an invalid address", () => {
    render(<SetupCatalogHarness targets={[]} />);
    fireEvent.paste(screen.getByLabelText("Careers or job-board URL"), {
      clipboardData: {
        getData: () => "https://valid.example.test/jobs\nhttps://",
      },
    });
    expect(
      screen
        .getByRole("button", { name: "Add and turn on" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      document.querySelectorAll("[data-profile-setup-source-card]"),
    ).toHaveLength(0);
  });

  it("explains unsupported guidance and blocks enabling sources without valid URLs", () => {
    render(
      <SetupCatalogHarness
        targets={[
          createCatalogTarget(1, {
            id: "catalog_target_unsupported",
            label: "Unsupported board",
            instructionStatus: "unsupported",
          }),
          createCatalogTarget(2, {
            id: "catalog_target_broken",
            label: "Broken board",
            startingUrl: "not-a-url",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Unsupported for checks")).toBeTruthy();
    expect(
      screen.getByText(
        "Automated checks could not read this site reliably yet.",
      ),
    ).toBeTruthy();

    expect(
      screen
        .getByRole("checkbox", {
          name: "Include Unsupported board in searches",
        })
        .hasAttribute("disabled"),
    ).toBe(false);

    expect(
      screen
        .getByRole("checkbox", {
          name: "Include Broken board in searches",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        "This source needs a complete http or https URL. Choose Edit to fix it before enabling it.",
      ),
    ).toBeTruthy();
  });
  it("keeps a typed-but-unadded source when the step is saved", () => {
    function FooterHarness() {
      const profileForm = useForm<ProfileEditorValues>({
        defaultValues: createProfileEditorValues(profile),
      });
      const preferencesForm = useForm<SearchPreferencesEditorValues>({
        defaultValues: {
          ...createSearchPreferencesEditorValues(baselinePreferences),
          discoveryTargets: [],
        },
      });
      const targets = preferencesForm.watch("discoveryTargets") ?? [];

      return (
        <>
          <ProfileSetupTargetingStep
            nextStep="narrative"
            onSaveAndGoToStep={() => undefined}
            preferencesForm={preferencesForm}
            profileForm={profileForm}
            renderFooter={(options) => (
              <button
                onClick={() => options?.onPrimary?.()}
                type="button"
              >
                {options?.nextLabel}
              </button>
            )}
          />
          <output data-saved-source-count={String(targets.length)}>
            {targets.map((target) => target.label).join(", ")}
          </output>
        </>
      );
    }

    render(<FooterHarness />);

    fireEvent.change(screen.getByLabelText("Source name (optional)"), {
      target: { value: "Acme careers" },
    });
    fireEvent.change(screen.getByLabelText("Careers or job-board URL"), {
      target: { value: "https://acme.example/careers" },
    });

    // The person typed a complete source and left the step without pressing
    // Add. It used to disappear without a word.
    fireEvent.click(
      screen.getByRole("button", { name: "Save and continue to Extras" }),
    );

    expect(
      document
        .querySelector("[data-saved-source-count]")
        ?.getAttribute("data-saved-source-count"),
    ).toBe("1");
    expect(screen.getAllByText(/Acme careers/).length).toBeGreaterThan(0);
  });

  it("adds a source without checking it automatically", () => {
    const onRunSourceDebug = vi.fn();
    const onSaveAndGoToStep = vi.fn();

    function SourceCheckHarness() {
      const profileForm = useForm<ProfileEditorValues>({
        defaultValues: createProfileEditorValues(profile),
      });
      const preferencesForm = useForm<SearchPreferencesEditorValues>({
        defaultValues: {
          ...createSearchPreferencesEditorValues(baselinePreferences),
          discoveryTargets: [],
        },
      });

      return (
        <ProfileSetupTargetingStep
          isProfileSetupPending={false}
          nextStep="extras"
          onRunSourceDebug={onRunSourceDebug}
          onSaveAndGoToStep={onSaveAndGoToStep}
          preferencesForm={preferencesForm}
          profileForm={profileForm}
          recentSourceDebugRuns={[]}
          renderFooter={() => null}
          savedDiscoveryTargets={[]}
        />
      );
    }

    render(<SourceCheckHarness />);
    fireEvent.change(screen.getByLabelText("Source name (optional)"), {
      target: { value: "Acme careers" },
    });
    fireEvent.change(screen.getByLabelText("Careers or job-board URL"), {
      target: { value: "https://acme.example/careers" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));

    expect(screen.queryByText("Checking this site…")).toBeNull();
    expect(onSaveAndGoToStep).not.toHaveBeenCalled();
    expect(onRunSourceDebug).not.toHaveBeenCalled();
    expect(screen.getByText("Acme careers")).toBeTruthy();
  });
});

it("splits pasted roles using the same semicolon separator as places", () => {
  render(<SetupCatalogHarness targets={[]} />);
  const input = screen.getByPlaceholderText("Add a target role");
  fireEvent.change(input, {
    target: {
      value: "Junior Data Analyst; Junior Data Scientist; Working Student Data Analytics",
    },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  for (const role of [
    "Junior Data Analyst",
    "Junior Data Scientist",
    "Working Student Data Analytics",
  ]) {
    expect(screen.getByText(role)).toBeTruthy();
  }
});

it("validates and splits URL lists filled without a paste event", () => {
  render(<SetupCatalogHarness targets={[]} />);
  const field = screen.getByLabelText("Careers or job-board URL");
  fireEvent.change(field, {
    target: { value: "https://one.example/careers https://two.example/jobs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add and turn on" }));
  expect(screen.getAllByText("one.example/careers").length).toBeGreaterThan(0);
  expect(screen.getAllByText("two.example/jobs").length).toBeGreaterThan(0);
  fireEvent.change(field, {
    target: {
      value:
        "https://one.example/careers not a web address https://two.example/jobs",
    },
  });
  expect(screen.getByText(/is not a web address/)).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Add and turn on" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByText(/Added 2 sources and turned them on/)).toBeNull();
});
