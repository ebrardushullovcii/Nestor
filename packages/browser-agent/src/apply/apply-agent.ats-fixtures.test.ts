import {
  CandidateProfileSchema,
  type CandidateProfile,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import type { LLMClient } from "../agent/contracts";
import type { ToolCall } from "../types";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type {
  ApplyAgentConfig,
  ApplyDocument,
  ApplyFormObservation,
  ApplyPageHands,
} from "./types";

/**
 * Sites shaped like the ones people actually meet.
 *
 * These are not tests of a form-filler. They are tests of a harness: the run
 * starts wherever the job link points, and everything after that — a cookie
 * banner in the way, a listing whose Apply button opens another company's
 * site in a new tab, a chain of redirects, a form spread over five screens —
 * is for the model to work out. Nothing in the code under test knows what
 * "Apply" means or which of these sites is which.
 */

interface FixtureControl {
  label: string;
  groupLabel?: string;
  tagName?: "input" | "textarea" | "select" | "contenteditable";
  inputType?: string;
  role?: string;
  required?: boolean;
  options?: string[];
  value?: string;
  checked?: boolean;
}

interface FixtureLink {
  label: string;
  href: string;
  target?: string;
}

interface FixtureClickable {
  label: string;
  /** Pressing it removes this clickable and reveals the rest of the page. */
  dismisses?: boolean;
}

interface FixturePage {
  title: string;
  bodyText?: string;
  stepLabel?: string;
  headings?: string[];
  controls?: FixtureControl[];
  actions?: string[];
  links?: FixtureLink[];
  clickables?: FixtureClickable[];
  /** Where an action at this index leads, for multi-screen forms. */
  advanceTo?: Record<string, string>;
  /** This page immediately sends the browser somewhere else. */
  redirectsTo?: string;
  openedTabs?: { url: string; title: string }[];
}

interface FixtureSite {
  startUrl: string;
  pages: Record<string, FixturePage>;
}

interface FixtureState {
  url: string;
  values: Map<string, string>;
  checked: Map<string, boolean>;
  dismissed: Set<string>;
  observations: ApplyFormObservation[];
  clicks: string[];
  visited: string[];
}

function controlKey(url: string, index: number): string {
  return `${url}:${index}`;
}

function toRawControl(
  control: FixtureControl,
  index: number,
  url: string,
  state: FixtureState,
): RawApplyControl {
  const key = controlKey(url, index);
  const tagName = control.tagName ?? "input";
  const value = state.values.get(key) ?? control.value ?? "";
  return {
    index,
    tagName,
    inputType: control.inputType ?? (tagName === "select" ? "select" : "text"),
    role: control.role ?? "",
    id: `field_${index}`,
    name: `field_${index}`,
    label: control.label,
    groupLabel: control.groupLabel ?? "",
    placeholder: "",
    autocomplete: "",
    required: control.required ?? false,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value,
    checked: state.checked.get(key) ?? control.checked ?? false,
    multiple: false,
    options: control.options ?? [],
    selectedOptionLabel: control.options ? value : "",
  };
}

function pageOf(site: FixtureSite, state: FixtureState): FixturePage {
  const page = site.pages[state.url];
  if (!page) {
    throw new Error(`Fixture has no page ${state.url}`);
  }
  return page;
}

function buildRawPage(site: FixtureSite, state: FixtureState): RawApplyPage {
  const page = pageOf(site, state);
  const clickables = (page.clickables ?? []).filter(
    (entry) => !state.dismissed.has(`${state.url}:${entry.label}`),
  );
  // A banner sitting over the page hides what is behind it, exactly as it
  // would for a person who had not dismissed it yet.
  const covered = clickables.some((entry) => entry.dismisses);
  return {
    url: state.url,
    title: page.title,
    bodyText: page.bodyText ?? page.title,
    headings: (page.headings ?? []).map((text) => ({ level: 1, text })),
    controls: covered
      ? []
      : (page.controls ?? []).map((control, index) =>
          toRawControl(control, index, state.url, state),
        ),
    actions: covered
      ? []
      : (page.actions ?? []).map((label, index) => ({
          index,
          label,
          visible: true,
          disabled: false,
        })),
    links: covered
      ? []
      : (page.links ?? []).map((link, index) => ({
          index,
          label: link.label,
          href: link.href,
          target: link.target ?? "",
          visible: true,
          topOffset: index * 40,
        })),
    clickables: clickables.map((entry, index) => ({
      index,
      label: entry.label,
      role: "button",
      tagName: "div",
      visible: true,
      topOffset: index * 20,
    })),
    openedTabs: (page.openedTabs ?? []).map((tab, index) => ({
      index,
      url: tab.url,
      title: tab.title,
    })),
    validationErrors: [],
    stepLabel: page.stepLabel ?? null,
    loading: false,
  };
}

function createFixtureHands(site: FixtureSite): {
  hands: ApplyPageHands;
  state: FixtureState;
} {
  const state: FixtureState = {
    url: site.startUrl,
    values: new Map(),
    checked: new Map(),
    dismissed: new Set(),
    observations: [],
    clicks: [],
    visited: [site.startUrl],
  };

  const refIndex = (ref: string): number => Number.parseInt(ref.slice(1), 10);

  const goTo = (url: string) => {
    state.url = url;
    state.visited.push(url);
    // A redirect chain resolves before anything looks at the page.
    for (let hop = 0; hop < 6; hop += 1) {
      const next = site.pages[state.url]?.redirectsTo;
      if (!next) break;
      state.url = next;
      state.visited.push(next);
    }
  };

  const observe = (): Promise<ApplyFormObservation> => {
    const observation = buildApplyFormObservation(
      buildRawPage(site, state),
      "2026-09-14T10:00:00.000Z",
    );
    state.observations.push(observation);
    return Promise.resolve(observation);
  };

  const hands: ApplyPageHands = {
    observe,
    navigate: (url) => {
      goTo(url);
      return Promise.resolve({ ok: true, url: state.url });
    },
    followLink: (ref) => {
      const link = pageOf(site, state).links?.[refIndex(ref)];
      if (!link) {
        return Promise.resolve({ ok: false, error: "No such link." });
      }
      goTo(link.href);
      return Promise.resolve({ ok: true, url: state.url });
    },
    clickElement: (ref) => {
      const page = pageOf(site, state);
      if (ref.startsWith("e")) {
        const clickable = (page.clickables ?? []).filter(
          (entry) => !state.dismissed.has(`${state.url}:${entry.label}`),
        )[refIndex(ref)];
        if (clickable) {
          state.clicks.push(clickable.label);
          state.dismissed.add(`${state.url}:${clickable.label}`);
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        }
      }
      if (ref.startsWith("a")) {
        const label = page.actions?.[refIndex(ref)];
        if (label) {
          state.clicks.push(label);
          const next = page.advanceTo?.[label];
          if (next) goTo(next);
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        }
      }
      if (ref.startsWith("l")) {
        const link = page.links?.[refIndex(ref)];
        if (link) {
          state.clicks.push(link.label);
          goTo(link.href);
          return Promise.resolve({ ok: true, observedValue: "clicked" });
        }
      }
      return Promise.resolve({ ok: false, error: "Nothing there." });
    },
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => {
      state.visited.pop();
      state.url = state.visited.at(-1) ?? site.startUrl;
      return Promise.resolve({ ok: true, url: state.url });
    },
    readText: () => Promise.resolve(pageOf(site, state).bodyText ?? ""),
    fillText: (ref, value) => {
      state.values.set(controlKey(state.url, refIndex(ref)), value);
      return Promise.resolve({ ok: true, observedValue: value });
    },
    chooseOption: (ref, optionLabel) => {
      state.values.set(controlKey(state.url, refIndex(ref)), optionLabel);
      return Promise.resolve({ ok: true, observedValue: optionLabel });
    },
    setToggle: (ref, checked) => {
      state.checked.set(controlKey(state.url, refIndex(ref)), checked);
      return Promise.resolve({
        ok: true,
        observedValue: checked ? "checked" : "unchecked",
      });
    },
    uploadFile: (ref, file) => {
      state.values.set(controlKey(state.url, refIndex(ref)), file.name);
      return Promise.resolve({ ok: true, observedValue: file.name });
    },
    clickAction: (ref) => hands.clickElement(ref),
  };

  return { hands, state };
}

/**
 * A stand-in for the model that uses the harness the way the prompt asks.
 *
 * It reads the page, gets whatever is in the way out of the way, follows the
 * apply route when there is no form yet, fills the page from the person's
 * facts in one step, and says when the form is complete. It knows nothing
 * about any of these sites.
 */
function createHarnessModel(
  state: FixtureState,
  resumeDocumentId: string,
): LLMClient {
  let callId = 0;
  const done = new Set<string>();
  let facts: {
    name: { full: string; first: string; last: string };
    email: string;
    phone: string;
    location: { city: string };
    yearsExperience: number;
    workEligibility: { noticePeriodDays: number; availableStartDate: string };
  } | null = null;
  const answerFor = (
    control: ApplyFormObservation["controls"][number],
  ): string => {
    const label = `${control.groupLabel} ${control.label}`.toLowerCase();
    if (control.options.length > 0) return control.options[0] ?? "";
    if (control.kind === "checkbox") return "yes";
    if (!facts) return "";
    if (/first name/u.test(label)) return facts.name.first;
    if (/last name/u.test(label)) return facts.name.last;
    if (/name/u.test(label)) return facts.name.full;
    if (/email/u.test(label)) return facts.email;
    if (/phone/u.test(label)) return facts.phone;
    if (/city/u.test(label)) return facts.location.city;
    if (/years/u.test(label)) return String(facts.yearsExperience);
    if (/notice/u.test(label))
      return `${facts.workEligibility.noticePeriodDays} days`;
    if (/start/u.test(label)) return facts.workEligibility.availableStartDate;
    return "I want to build dependable platforms for the teams who use them.";
  };

  const call = (name: string, args: Record<string, unknown>): ToolCall => {
    callId += 1;
    return {
      id: `call_${callId}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
  };

  const decide = (): { toolCalls: ToolCall[] } => {
    const seen = state.observations.at(-1);
    if (!seen) return { toolCalls: [call("observe", {})] };
    const here = seen.url ?? "";

    // Anything sitting over the page comes off first.
    const overlay = seen.clickables.find(
      (entry) => entry.visible && !done.has(`${here}:${entry.ref}`),
    );
    if (overlay) {
      done.add(`${here}:${overlay.ref}`);
      return { toolCalls: [call("click", { ref: overlay.ref })] };
    }

    // A page with no way to send anything is not the application, whatever
    // fields it happens to carry — a board's search box and chat input are not
    // an application form. Take the apply route first.
    const looksSubmittable = seen.actions.some(
      (action) => action.visible && /submit|send|apply/i.test(action.label),
    );
    if (!looksSubmittable) {
      const route =
        seen.links.find(
          (link) =>
            link.visible &&
            /apply/i.test(link.label) &&
            !done.has(`${here}:${link.ref}`),
        ) ??
        seen.actions.find(
          (action) =>
            action.visible &&
            /apply/i.test(action.label) &&
            !done.has(`${here}:${action.ref}`),
        );
      if (route) {
        done.add(`${here}:${route.ref}`);
        return {
          toolCalls: [
            call(route.ref.startsWith("l") ? "follow_link" : "click", {
              ref: route.ref,
            }),
          ],
        };
      }
    }

    // Every field that has not been dealt with, in one step: files with
    // upload, everything else with fill_fields.
    const pending = seen.controls.filter(
      (control) =>
        control.visible &&
        !control.disabled &&
        !control.answered &&
        !done.has(`${here}:${control.ref}`),
    );
    if (pending.length > 0) {
      const calls: ToolCall[] = [];
      const fields: Array<Record<string, unknown>> = [];
      for (const control of pending) {
        done.add(`${here}:${control.ref}`);
        if (control.kind === "file") {
          calls.push(
            call("upload", { ref: control.ref, documentId: resumeDocumentId }),
          );
        } else {
          fields.push(
            control.kind === "checkbox" || control.kind === "radio"
              ? { tool: "set_checkbox", ref: control.ref, checked: true }
              : control.kind === "select" || control.kind === "combobox"
                ? {
                    tool: "select",
                    ref: control.ref,
                    option: answerFor(control),
                  }
                : { tool: "type", ref: control.ref, text: answerFor(control) },
          );
        }
      }
      if (fields.length > 0) calls.push(call("fill_fields", { fields }));
      return { toolCalls: calls };
    }

    // Everything is filled in: move on, or say it is complete.
    const advance = seen.actions.find(
      (action) =>
        action.visible &&
        /next|continue/i.test(action.label) &&
        !done.has(`${here}:${action.ref}`),
    );
    if (advance) {
      done.add(`${here}:${advance.ref}`);
      return { toolCalls: [call("click", { ref: advance.ref })] };
    }
    const send = seen.actions.find(
      (action) => action.visible && /submit|send/i.test(action.label),
    );
    if (send && !done.has(`${here}:send`)) {
      done.add(`${here}:send`);
      return { toolCalls: [call("submit_application", { ref: send.ref })] };
    }
    return {
      toolCalls: [call("finish", { reason: "The form is filled in." })],
    };
  };

  return {
    chatWithTools: (_messages, _tools, options) => {
      if (_tools[0]?.function.name === "report_answer_checks") {
        const asked = JSON.parse(String(_messages[1]?.content ?? "{}")) as {
          applicant: {
            yearsExperience: number;
            workEligibility: Record<string, unknown>;
          };
          answers?: Array<{ question: string; proposedAnswer: string }>;
        };
        return Promise.resolve({
          toolCalls: [
            call("report_answer_checks", {
              checks: (asked.answers ?? []).map((answer, index) => ({
                index,
                supported: true,
                evidence: [
                  {
                    kind: "applicant_fact",
                    claim: "Scripted fixture verdict",
                    source: "applicant",
                    path: /years/iu.test(answer.question)
                      ? "/yearsExperience"
                      : /notice/iu.test(answer.question)
                        ? "/workEligibility/Notice period in days"
                        : "/workEligibility/Available start date",
                    quote: String(
                      /years/iu.test(answer.question)
                        ? asked.applicant.yearsExperience
                        : /notice/iu.test(answer.question)
                          ? asked.applicant.workEligibility[
                              "Notice period in days"
                            ]
                          : asked.applicant.workEligibility[
                              "Available start date"
                            ],
                    ),
                  },
                ],
                reason:
                  "The fixture answer expresses motivation without adding personal history.",
              })),
            }),
          ],
        });
      }
      const factsMessage = _messages.find(
        (message) =>
          message.role === "user" &&
          String(message.content).startsWith("The person's facts"),
      );
      if (factsMessage && !facts) {
        const text = String(factsMessage.content);
        const json = text.slice(text.indexOf("\n") + 1).split("\n\n")[0];
        facts = JSON.parse(json ?? "{}") as typeof facts;
      }
      // Record what the model was told, the way a real client would consume it.
      void options;
      return Promise.resolve(decide());
    },
  };
}

function createTestProfile(): CandidateProfile {
  return CandidateProfileSchema.parse({
    id: "candidate_test",
    firstName: "Robin",
    lastName: "Ashford",
    fullName: "Robin Ashford",
    headline: "Platform engineer",
    summary: "Builds dependable internal tools.",
    currentLocation: "Manchester, United Kingdom",
    currentCity: "Manchester",
    currentCountry: "United Kingdom",
    yearsExperience: 8,
    email: "robin.ashford@example.test",
    phone: "+44 7700 900123",
    portfolioUrl: "https://portfolio.example.test/robin",
    baseResume: {
      id: "resume_test",
      fileName: "resume.txt",
      uploadedAt: "2026-09-01T09:00:00.000Z",
      textContent: "8 years of platform engineering.",
      textUpdatedAt: "2026-09-01T09:00:00.000Z",
      extractionStatus: "ready",
    },
    workEligibility: {
      authorizedWorkCountries: ["United Kingdom"],
      requiresVisaSponsorship: false,
      willingToRelocate: true,
      willingToTravel: true,
      noticePeriodDays: 30,
      availableStartDate: "2026-11-01",
    },
  });
}

function createResumeDocument(): ApplyDocument {
  return {
    id: "document_resume",
    fileName: "robin-ashford-resume.pdf",
    mimeType: "application/pdf",
    label: "Your CV",
    kind: "resume",
    loadBytes: () => Promise.resolve(new Uint8Array([37, 80, 68, 70])),
  };
}

function createConfig(
  site: FixtureSite,
  siteLabel: string,
): { config: ApplyAgentConfig; state: FixtureState } {
  const { hands, state } = createFixtureHands(site);
  const config: ApplyAgentConfig = {
    hands,
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: createTestProfile(),
      resumeText: "Robin Ashford. 8 years of platform engineering.",
      posting: {
        title: "Platform Engineer",
        company: "Northwind Tools",
        location: "Manchester, United Kingdom",
        description: "Own the internal platform.",
      },
      reusableAnswers: [
        {
          id: "own-motivation",
          kind: "other",
          question: "Why do you want to work here?",
          label: "Motivation",
          answer:
            "I want to build dependable platforms for the teams who use them.",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ],
      documents: [createResumeDocument()],
    },
    application: {
      jobId: "job_test",
      applicationId: "application_test",
      startingUrl: site.startUrl,
    },
    siteLabel,
    runControl: { maxSteps: 120, noProgressStepLimit: 12 },
    now: () => new Date("2026-09-14T10:00:00.000Z"),
  };
  return { config, state };
}

const FORM_CONTROLS: FixtureControl[] = [
  { label: "First Name", required: true },
  { label: "Last Name", required: true },
  { label: "Email", inputType: "email", required: true },
  { label: "Phone", inputType: "tel" },
  { label: "Resume/CV", inputType: "file", required: true },
];

const cardStyleBoard: FixtureSite = {
  startUrl: "https://boards.example-greenhouse.test/northwind/jobs/1",
  pages: {
    "https://boards.example-greenhouse.test/northwind/jobs/1": {
      title: "Platform Engineer — Northwind Tools",
      controls: FORM_CONTROLS,
      actions: ["Submit Application"],
    },
  },
};

const postingStyleBoard: FixtureSite = {
  startUrl: "https://jobs.example-lever.test/northwind/2/apply",
  pages: {
    "https://jobs.example-lever.test/northwind/2/apply": {
      title: "Apply — Platform Engineer",
      controls: [
        { label: "Full name", required: true },
        { label: "Email", inputType: "email", required: true },
        { label: "Resume", inputType: "file", required: true },
        {
          label: "Why do you want to work here?",
          tagName: "textarea",
          required: true,
        },
      ],
      actions: ["Submit application"],
    },
  },
};

const multiScreenCareerSite: FixtureSite = {
  startUrl: "https://northwind.example-workday.test/apply",
  pages: {
    "https://northwind.example-workday.test/apply": {
      title: "Northwind Careers",
      stepLabel: "Step 1 of 3 — My Information",
      controls: [
        { label: "First Name", required: true },
        { label: "Last Name", required: true },
        { label: "City", required: true },
      ],
      actions: ["Next"],
      advanceTo: { Next: "https://northwind.example-workday.test/apply/2" },
    },
    "https://northwind.example-workday.test/apply/2": {
      title: "Northwind Careers",
      stepLabel: "Step 2 of 3 — My Experience",
      controls: [
        { label: "Resume", inputType: "file", required: true },
        { label: "Years of experience", required: true },
      ],
      actions: ["Next"],
      advanceTo: { Next: "https://northwind.example-workday.test/apply/3" },
    },
    "https://northwind.example-workday.test/apply/3": {
      title: "Northwind Careers",
      stepLabel: "Step 3 of 3 — Review",
      controls: [{ label: "Notice period", required: true }],
      actions: ["Submit"],
    },
  },
};

const compactSinglePage: FixtureSite = {
  startUrl: "https://jobs.example-ashby.test/northwind/application",
  pages: {
    "https://jobs.example-ashby.test/northwind/application": {
      title: "Northwind Tools — Application",
      controls: [
        { label: "Name", required: true },
        { label: "Email", inputType: "email", required: true },
        { label: "Resume", inputType: "file", required: true },
        { label: "When can you start?", required: true },
      ],
      actions: ["Submit application"],
    },
  },
};

const inPageModal: FixtureSite = {
  startUrl: "https://www.example-network.test/jobs/view/3",
  pages: {
    "https://www.example-network.test/jobs/view/3": {
      title: "Platform Engineer | Northwind Tools",
      stepLabel: "1/2",
      controls: [
        { label: "Email address", inputType: "email", required: true },
        { label: "Mobile phone number", inputType: "tel", required: true },
        { label: "Resume", inputType: "file", required: true },
      ],
      actions: ["Next"],
      advanceTo: { Next: "https://www.example-network.test/jobs/view/3/2" },
    },
    "https://www.example-network.test/jobs/view/3/2": {
      title: "Platform Engineer | Northwind Tools",
      stepLabel: "2/2",
      controls: [
        { label: "How many years of experience do you have?", required: true },
      ],
      actions: ["Submit application"],
    },
  },
};

/**
 * A board listing whose Apply opens the employer's own form in a new tab.
 *
 * The listing has a search box and a chat input, which is exactly the shape
 * that used to make Job Finder decide it was already looking at a form and
 * give up with "no application form or apply button" while a person could see
 * the Apply button plainly.
 */
const boardListingToExternalForm: FixtureSite = {
  startUrl: "https://example-remoteok.test/remote-jobs/12345-platform-engineer",
  pages: {
    "https://example-remoteok.test/remote-jobs/12345-platform-engineer": {
      title: "Platform Engineer at Northwind Tools",
      headings: ["Platform Engineer"],
      bodyText: "Remote. Own the internal platform. Apply below.",
      controls: [
        { label: "Search remote jobs", inputType: "search" },
        { label: "Ask our AI anything", tagName: "textarea" },
      ],
      links: [
        { label: "Home", href: "https://example-remoteok.test/" },
        {
          label: "Apply for this position",
          href: "https://boards.example-greenhouse.test/northwind/jobs/9",
          target: "_blank",
        },
      ],
    },
    "https://boards.example-greenhouse.test/northwind/jobs/9": {
      title: "Northwind Tools — Platform Engineer",
      controls: FORM_CONTROLS,
      actions: ["Submit Application"],
    },
  },
};

/** A cookie wall covering the form until it is dismissed. */
const cookieBannerSite: FixtureSite = {
  startUrl: "https://careers.example-cookie.test/apply/7",
  pages: {
    "https://careers.example-cookie.test/apply/7": {
      title: "Northwind Tools — Apply",
      clickables: [{ label: "Accept all cookies", dismisses: true }],
      controls: FORM_CONTROLS,
      actions: ["Submit Application"],
    },
  },
};

/** An apply link that bounces through a tracker before the real form. */
const redirectChainSite: FixtureSite = {
  startUrl: "https://example-aggregator.test/job/55",
  pages: {
    "https://example-aggregator.test/job/55": {
      title: "Platform Engineer — via aggregator",
      links: [
        {
          label: "Apply now",
          href: "https://example-tracker.test/click?id=55",
        },
      ],
    },
    "https://example-tracker.test/click?id=55": {
      title: "Redirecting",
      redirectsTo: "https://example-ats.test/apply/55?src=aggregator",
    },
    "https://example-ats.test/apply/55?src=aggregator": {
      title: "Northwind Tools — Application",
      redirectsTo: "https://example-ats.test/apply/55",
    },
    "https://example-ats.test/apply/55": {
      title: "Northwind Tools — Application",
      controls: FORM_CONTROLS,
      actions: ["Submit Application"],
    },
  },
};

const SITES: ReadonlyArray<readonly [string, FixtureSite, string]> = [
  ["a card-style board", cardStyleBoard, "Greenhouse"],
  ["a posting-style board", postingStyleBoard, "Lever"],
  ["a multi-screen career site", multiScreenCareerSite, "the careers site"],
  ["a compact single-page form", compactSinglePage, "Ashby"],
  ["an in-page modal", inPageModal, "the network site"],
  ["a board listing that links out", boardListingToExternalForm, "RemoteOK"],
  ["a site behind a cookie wall", cookieBannerSite, "the careers site"],
  ["an apply link behind redirects", redirectChainSite, "the aggregator"],
];

describe("the apply harness across real site shapes", () => {
  for (const [description, site, siteLabel] of SITES) {
    test(`fills ${description} and stops before sending`, async () => {
      const { config, state } = createConfig(site, siteLabel);
      const result = await runApplyAgent(
        config,
        createHarnessModel(state, "document_resume"),
      );

      expect(result.outcome).toBe("prepared");
      expect(result.filled.length).toBeGreaterThan(0);
      expect(result.attachments).toHaveLength(1);
      expect(result.pauses).toHaveLength(0);

      // Nothing that sends the application was ever pressed.
      expect(
        state.clicks.filter((label) => /submit|send/iu.test(label)),
      ).toHaveLength(0);

      // Every answer says where it came from.
      for (const entry of result.filled) {
        expect(entry.answer.provenanceLabel.length).toBeGreaterThan(0);
        expect(entry.answer.groundedIn.length).toBeGreaterThan(0);
      }

      // The last page has no required field left empty.
      const last = state.observations.at(-1);
      expect(
        last?.controls.filter(
          (control) => control.required && !control.answered,
        ),
      ).toHaveLength(0);
    });
  }

  test("a listing with a search box and a chat input is not mistaken for a form", async () => {
    const { config, state } = createConfig(
      boardListingToExternalForm,
      "RemoteOK",
    );
    const result = await runApplyAgent(
      config,
      createHarnessModel(state, "document_resume"),
    );

    expect(result.outcome).toBe("prepared");
    // It left the board and reached the employer's own form.
    expect(state.url).toBe(
      "https://boards.example-greenhouse.test/northwind/jobs/9",
    );
    // A target=_blank apply link is followed in place rather than refused.
    expect(state.visited).toContain(
      "https://boards.example-greenhouse.test/northwind/jobs/9",
    );
    expect(result.filled.map((entry) => entry.label)).toContain("Email");
  });

  test("a cookie wall is dismissed by the run rather than stopping it", async () => {
    const { config, state } = createConfig(
      cookieBannerSite,
      "the careers site",
    );
    const result = await runApplyAgent(
      config,
      createHarnessModel(state, "document_resume"),
    );

    expect(state.clicks).toContain("Accept all cookies");
    expect(result.outcome).toBe("prepared");
    expect(result.filled.length).toBeGreaterThan(0);
  });

  test("a chain of redirects is followed to the form at the end of it", async () => {
    const { config, state } = createConfig(redirectChainSite, "the aggregator");
    const result = await runApplyAgent(
      config,
      createHarnessModel(state, "document_resume"),
    );

    expect(state.url).toBe("https://example-ats.test/apply/55");
    expect(state.visited).toContain("https://example-tracker.test/click?id=55");
    expect(result.outcome).toBe("prepared");
    expect(result.attachments).toHaveLength(1);
  });

  test("the multi-screen form is walked screen by screen", async () => {
    const { config, state } = createConfig(
      multiScreenCareerSite,
      "the careers site",
    );
    const result = await runApplyAgent(
      config,
      createHarnessModel(state, "document_resume"),
    );

    expect(result.outcome).toBe("prepared");
    expect(state.url).toBe("https://northwind.example-workday.test/apply/3");
    expect(state.clicks.filter((label) => label === "Next")).toHaveLength(2);
  });
});
