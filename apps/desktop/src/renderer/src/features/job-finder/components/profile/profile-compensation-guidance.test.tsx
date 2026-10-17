// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFieldArray, useForm } from "react-hook-form";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  createSearchPreferencesEditorValues,
  type ProfileEditorValues,
  type SearchPreferencesEditorValues,
} from "../../lib/profile-editor";
import {
  PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES,
  PROFILE_DEEP_LINK_TOP_GAP_PX,
  PROFILE_SECTION_SCROLL_AREA_ID,
} from "./profile-deep-link-focus";
import { ProfilePreferencesEligibilitySection } from "./profile-preferences-eligibility-section";
import { ProfilePreferencesTargetingSection } from "./profile-preferences-sections";

const profile = CandidateProfileSchema.parse({
  id: "candidate_compensation_guidance",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Software engineer",
  summary: "Builds dependable products.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 7,
  workEligibility: {},
  professionalSummary: {},
  narrative: {},
  baseResume: {
    id: "resume_compensation_guidance",
    fileName: "alex.pdf",
    uploadedAt: "2026-08-11T10:00:00.000Z",
    extractionStatus: "ready",
  },
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

const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: [],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  discovery: { targets: [] },
});

function TargetingHarness() {
  const preferencesForm = useForm<SearchPreferencesEditorValues>({
    defaultValues: createSearchPreferencesEditorValues(preferences),
  });

  return (
    <ProfilePreferencesTargetingSection preferencesForm={preferencesForm} />
  );
}

function EligibilityHarness() {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const customAnswerArray = useFieldArray({
    control: profileForm.control,
    keyName: "fieldKey",
    name: "answerBank.customAnswers",
  });

  return (
    <ProfilePreferencesEligibilitySection
      busy={false}
      customAnswerArray={customAnswerArray}
      profileForm={profileForm}
    />
  );
}

describe("profile compensation guidance", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("distinguishes the matching floor and opens the expected application answer", () => {
    render(<TargetingHarness />);

    expect(container?.textContent).toContain("Minimum worth considering");
    expect(container?.textContent).toContain("Target compensation (optional)");
    expect(container?.textContent).toContain(
      "The minimum is your consideration floor",
    );
    const answerLink = container?.querySelector<HTMLAnchorElement>(
      'a[href="#profile-expected-salary-answer-field"]',
    );
    expect(answerLink).toBeTruthy();

    const answerField = document.createElement("textarea");
    const answerFieldWrapper = document.createElement("div");
    answerFieldWrapper.id = "profile-expected-salary-answer-field";
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    answerField.id = "profile-expected-salary-answer";
    answerFieldWrapper.scrollIntoView = scrollIntoView;
    answerField.focus = focus;
    answerFieldWrapper.appendChild(answerField);
    document.body.appendChild(answerFieldWrapper);

    const nativeActivationWasAllowed = fireEvent.click(answerLink!);

    expect(nativeActivationWasAllowed).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    answerFieldWrapper.remove();
  });

  it("labels the reusable salary response as an application answer", () => {
    render(<EligibilityHarness />);

    const field = container?.querySelector<HTMLTextAreaElement>(
      "#profile-expected-salary-answer",
    );
    expect(field).toBeTruthy();
    expect(container?.textContent).toContain(
      "Expected salary answer (applications)",
    );
    expect(container?.textContent).toContain(
      "It may be higher than your minimum job-search floor",
    );
  });
});

const profileRouteMarker = "profile-route-content";
const jobFinderHomeRouteMarker = "job-finder-home-route";
const ejectedRouteMarker = "unknown-route-fallback";

describe("ProfilePreferencesTargetingSection salary answer anchor navigation", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  const flushJsdomNavigationTimers = async () => {
    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    });
  };

  const renderTargetingHashRoute = () => {
    window.location.hash = "#/job-finder/profile";

    render(
      <HashRouter>
        <Routes>
          <Route
            element={
              <div>
                <p>{profileRouteMarker}</p>
                <TargetingHarness />
              </div>
            }
            path="/job-finder/profile"
          />
          <Route
            element={<p>{jobFinderHomeRouteMarker}</p>}
            path="/job-finder"
          />
          <Route element={<p>{ejectedRouteMarker}</p>} path="*" />
        </Routes>
      </HashRouter>,
    );

    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="#profile-expected-salary-answer-field"]',
    );
    if (!link) {
      throw new Error("Missing reusable screener answers anchor link");
    }

    return link;
  };

  const stubSalaryAnswerField = () => {
    document.getElementById("profile-expected-salary-answer")?.remove();
    document.getElementById("profile-expected-salary-answer-field")?.remove();
    const answerField = document.createElement("textarea");
    const answerFieldWrapper = document.createElement("div");
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    answerField.id = "profile-expected-salary-answer";
    answerFieldWrapper.id = "profile-expected-salary-answer-field";
    answerFieldWrapper.scrollIntoView = scrollIntoView;
    answerField.focus = focus;
    answerFieldWrapper.appendChild(answerField);
    document.body.appendChild(answerFieldWrapper);
    return { focus, scrollIntoView };
  };

  const removeSalaryAnswerField = () => {
    document.getElementById("profile-expected-salary-answer-field")?.remove();
    document.getElementById("profile-expected-salary-answer")?.remove();
  };

  const expectRouteStaysOnProfile = () => {
    expect(window.location.hash).toBe("#/job-finder/profile");
    expect(screen.queryByText(profileRouteMarker)).not.toBeNull();
    expect(screen.queryByText(jobFinderHomeRouteMarker)).toBeNull();
    expect(screen.queryByText(ejectedRouteMarker)).toBeNull();
  };

  it("keeps the router on profile and scrolls and focuses the expected application answer on plain clicks", async () => {
    const link = renderTargetingHashRoute();
    const { focus, scrollIntoView } = stubSalaryAnswerField();

    try {
      const nativeActivationWasAllowed = fireEvent.click(link);
      await flushJsdomNavigationTimers();

      expect(nativeActivationWasAllowed).toBe(false);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "auto",
        block: "center",
      });
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expectRouteStaysOnProfile();
    } finally {
      removeSalaryAnswerField();
    }
  });

  it("still prevents default when the salary answer target is missing so the route never changes", async () => {
    const link = renderTargetingHashRoute();

    const focusSpy = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(() => {});
    const scrollIntoViewSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewSpy,
    });

    try {
      const nativeActivationWasAllowed = fireEvent.click(link);
      await flushJsdomNavigationTimers();

      expect(nativeActivationWasAllowed).toBe(false);
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      expect(focusSpy).not.toHaveBeenCalled();
      expectRouteStaysOnProfile();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it.each([
    { description: "alt-click", init: { altKey: true } },
    { description: "ctrl-click", init: { ctrlKey: true } },
    { description: "meta-click", init: { metaKey: true } },
    { description: "shift-click", init: { shiftKey: true } },
    { description: "middle-click", init: { button: 1 } },
  ] as const)(
    "leaves $description native without scrolling or focusing",
    async ({ init }) => {
      const link = renderTargetingHashRoute();
      const { focus, scrollIntoView } = stubSalaryAnswerField();

      try {
        const nativeActivationWasAllowed = fireEvent.click(link, init);
        await flushJsdomNavigationTimers();

        expect(nativeActivationWasAllowed).toBe(true);
        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(focus).not.toHaveBeenCalled();
      } finally {
        removeSalaryAnswerField();
      }
    },
  );
});

// Mirrors the locked Profile layout at xl: an outer screen scroll area owns
// the page while #profile-section-scroll-area is the nested bounded pane.
const SCROLLER_VIEWPORT_TOP_PX = 200;
const WRAPPER_CONTENT_OFFSET_PX = 1400;
let mountedWideFixtureRoot: HTMLElement | null = null;

function mountWideInternalScrollerFixture(options?: {
  wrapperContentOffsetPx?: number;
}) {
  const wrapperContentOffsetPx =
    options?.wrapperContentOffsetPx ?? WRAPPER_CONTENT_OFFSET_PX;

  const outerScrollArea = document.createElement("div");
  outerScrollArea.className = "screen-scroll-area";
  const sectionScroller = document.createElement("div");
  sectionScroller.id = PROFILE_SECTION_SCROLL_AREA_ID;
  const answerFieldWrapper = document.createElement("div");
  answerFieldWrapper.id = "profile-expected-salary-answer-field";
  const answerField = document.createElement("textarea");
  answerField.id = "profile-expected-salary-answer";

  const focus = vi.fn();
  answerField.focus = focus;

  answerFieldWrapper.appendChild(answerField);
  sectionScroller.appendChild(answerFieldWrapper);
  outerScrollArea.appendChild(sectionScroller);
  document.body.appendChild(outerScrollArea);
  mountedWideFixtureRoot = outerScrollArea;

  const outerScrollWrites: number[] = [];
  Object.defineProperty(outerScrollArea, "scrollTop", {
    configurable: true,
    get: () => outerScrollWrites.at(-1) ?? 0,
    set: (value: number) => {
      outerScrollWrites.push(value);
    },
  });

  // Simulated nested layout: the scroller viewport sits at a fixed distance
  // from the window top and its content scrolls with scrollTop.
  Object.defineProperty(sectionScroller, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ top: SCROLLER_VIEWPORT_TOP_PX }),
  });
  Object.defineProperty(answerFieldWrapper, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top:
        SCROLLER_VIEWPORT_TOP_PX +
        wrapperContentOffsetPx -
        sectionScroller.scrollTop,
    }),
  });

  return {
    answerField,
    answerFieldWrapper,
    focus,
    outerScrollArea,
    sectionScroller,
  };
}

describe("ProfilePreferencesTargetingSection wide internal-scroller reveal", () => {
  let originalInnerWidthDescriptor: PropertyDescriptor | undefined;
  const scrollIntoViewSpy = vi.fn();

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  beforeEach(() => {
    originalInnerWidthDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth",
    );
    // >= 1280 puts the profile chrome into internal-scroller mode.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });
    // jsdom does not implement scrollIntoView; install a recording stub so
    // the test proves this mode never relies on it.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewSpy,
    });
  });

  afterEach(() => {
    cleanup();
    mountedWideFixtureRoot?.remove();
    mountedWideFixtureRoot = null;
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    if (originalInnerWidthDescriptor) {
      Object.defineProperty(window, "innerWidth", originalInnerWidthDescriptor);
    } else {
      Reflect.deleteProperty(window, "innerWidth");
    }
    scrollIntoViewSpy.mockClear();
  });

  function getSalaryAnswerLink() {
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="#profile-expected-salary-answer-field"]',
    );
    if (!link) {
      throw new Error("Missing reusable screener answers anchor link");
    }
    return link;
  }

  it("scrolls only the section scroller so the field lands 16px below its top and focuses the textarea without moving ancestors", () => {
    render(<TargetingHarness />);
    const link = getSalaryAnswerLink();
    const { answerFieldWrapper, focus, outerScrollArea, sectionScroller } =
      mountWideInternalScrollerFixture();

    const nativeActivationWasAllowed = fireEvent.click(link);

    expect(nativeActivationWasAllowed).toBe(false);
    // The nested scroller receives the whole reveal; the outer screen area is
    // untouched and no scrollIntoView runs in this mode.
    expect(sectionScroller.scrollTop).toBe(
      WRAPPER_CONTENT_OFFSET_PX - PROFILE_DEEP_LINK_TOP_GAP_PX,
    );
    expect(outerScrollArea.scrollTop).toBe(0);
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    // Destination alignment: exactly one clearance gap under the scroller top.
    expect(
      answerFieldWrapper.getBoundingClientRect().top - SCROLLER_VIEWPORT_TOP_PX,
    ).toBe(PROFILE_DEEP_LINK_TOP_GAP_PX);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("clamps the reveal at the top of the section scroller when the field already sits above the clearance", () => {
    render(<TargetingHarness />);
    const link = getSalaryAnswerLink();
    const { focus, outerScrollArea, sectionScroller } =
      mountWideInternalScrollerFixture({ wrapperContentOffsetPx: 8 });

    const nativeActivationWasAllowed = fireEvent.click(link);

    expect(nativeActivationWasAllowed).toBe(false);
    expect(sectionScroller.scrollTop).toBe(0);
    expect(outerScrollArea.scrollTop).toBe(0);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

describe("ProfilePreferencesEligibilitySection expected salary answer scroll margins", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps only the owned deep-link margins on #profile-expected-salary-answer-field", () => {
    render(<EligibilityHarness />);

    const fieldWrapper = document.getElementById(
      "profile-expected-salary-answer-field",
    );
    expect(fieldWrapper).not.toBeNull();

    // The base breathing gap is preserved, the sm–xl fixed-header band adds
    // the shell clearance so modifier/native fallback cannot land under the
    // header, and xl resets to the gap so the manual internal-scroller reveal
    // math stays authoritative.
    expect(fieldWrapper?.className).toContain(
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base,
    );
    expect(fieldWrapper?.className).toContain(
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader,
    );
    expect(fieldWrapper?.className).toContain(
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller,
    );

    const marginClasses = fieldWrapper!.className
      .split(/\s+/)
      .filter((entry) => entry.includes("scroll-mt"));
    expect(marginClasses).toEqual([
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base,
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader,
      PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller,
    ]);
    expect(
      document.getElementById("profile-expected-salary-answer"),
    ).toBeTruthy();
  });
});

describe("preference usability controls", () => {
  afterEach(cleanup);

  it("R3-065 lets a person add and remove a limited permit beside unrestricted countries", () => {
    render(<EligibilityHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add limited permission" }),
    );
    fireEvent.change(screen.getByLabelText("Permit country"), {
      target: { value: "Germany" },
    });
    fireEvent.change(screen.getByLabelText("Permit limits"), {
      target: { value: "Student work only, 20 hours during term" },
    });
    fireEvent.change(
      screen.getByLabelText(
        "Will you need sponsorship for future work in this country?",
      ),
      { target: { value: "yes" } },
    );
    expect(screen.getByLabelText("Permit country")).toHaveProperty(
      "value",
      "Germany",
    );
    expect(
      screen.getByText(/Reusable answers do not override these limits/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove permit" }));
    expect(screen.queryByLabelText("Permit country")).toBeNull();
  });

  it("R3-105 and R3-138 expose shift, weekly hours and base/OTE choices", () => {
    render(<TargetingHarness />);
    fireEvent.change(screen.getByLabelText("Shifts"), {
      target: { value: "day" },
    });
    fireEvent.change(screen.getByLabelText("Minimum weekly hours"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("Maximum weekly hours"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Minimum pay counts as"), {
      target: { value: "total_ote" },
    });
    expect(screen.getByLabelText("Shifts")).toHaveProperty("value", "day");
    expect(screen.getByLabelText("Minimum weekly hours")).toHaveProperty(
      "value",
      "20",
    );
    expect(screen.getByLabelText("Maximum weekly hours")).toHaveProperty(
      "value",
      "30",
    );
    expect(screen.getByLabelText("Minimum pay counts as")).toHaveProperty(
      "value",
      "total_ote",
    );
  });
});
