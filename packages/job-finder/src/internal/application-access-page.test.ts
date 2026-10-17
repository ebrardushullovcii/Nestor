import type { RawApplyPage, UserActionRequest } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { inspectApplicationAccessPage } from "./application-access-page";

const request = {
  id: "user_action_login",
  kind: "login",
  scope: {
    type: "application",
    source: "target_site",
    jobId: "job_1",
    runId: "run_1",
    resultId: "result_1",
  },
  verification: {
    type: "source_access",
    expectedOrigin: "http://127.0.0.1:47950",
  },
} as unknown as UserActionRequest;

const baseControl: RawApplyPage["controls"][number] = {
  index: 0,
  tagName: "input",
  inputType: "text",
  role: "textbox",
  id: "name",
  name: "name",
  label: "Full name",
  groupLabel: "",
  placeholder: "",
  autocomplete: "",
  required: true,
  invalid: false,
  validationMessage: "",
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  multiple: false,
  options: [],
  selectedOptionLabel: "",
};

function page(overrides: Partial<RawApplyPage>): RawApplyPage {
  return {
    url: "http://127.0.0.1:47950/workday/apply/1/step/1",
    title: "My Information",
    bodyText: "My Information. Full name.",
    headings: [],
    controls: [baseControl],
    actions: [
      { index: 0, label: "Save and Continue", visible: true, disabled: false },
    ],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
    ...overrides,
  };
}

const signInPage = page({
  url: "http://127.0.0.1:47950/workday/account/signin/1",
  title: "Sign in",
  bodyText: "Sign in to apply. Email. Password.",
  controls: [
    {
      ...baseControl,
      id: "email",
      name: "email",
      label: "Email",
      inputType: "email",
    },
    {
      ...baseControl,
      index: 1,
      id: "password",
      name: "password",
      label: "Password",
      inputType: "password",
      autocomplete: "current-password",
    },
  ],
  actions: [{ index: 0, label: "Sign in", visible: true, disabled: false }],
});

function runtimeReading(raw: RawApplyPage | Error) {
  return {
    readApplicationPageBinding: vi.fn((_source: string, key: string) => {
      expect(key).toBe("result_1");
      return raw instanceof Error ? Promise.reject(raw) : Promise.resolve(raw);
    }),
  };
}

describe("inspectApplicationAccessPage", () => {
  test("a signed-in application step with no account menu is past the wall", async () => {
    await expect(
      inspectApplicationAccessPage({
        browserRuntime: runtimeReading(page({})),
        request,
      }),
    ).resolves.toBe("verified");
  });

  test("the sign-in form on the kept page is still blocked", async () => {
    await expect(
      inspectApplicationAccessPage({
        browserRuntime: runtimeReading(signInPage),
        request,
      }),
    ).resolves.toBe("still_blocked");
  });

  test("a page that is still loading is not read as signed in", async () => {
    await expect(
      inspectApplicationAccessPage({
        browserRuntime: runtimeReading(page({ loading: true })),
        request,
      }),
    ).resolves.toBe("still_blocked");
  });

  test("a lost binding is unavailable, never guessed from a URL", async () => {
    await expect(
      inspectApplicationAccessPage({
        browserRuntime: runtimeReading(
          new Error("The exact prepared application page is no longer open."),
        ),
        request,
      }),
    ).resolves.toBe("unavailable");
    await expect(
      inspectApplicationAccessPage({ browserRuntime: {}, request }),
    ).resolves.toBe("unavailable");
  });

  test("a source sign-in is not read through an application binding", async () => {
    const browserRuntime = runtimeReading(page({}));
    await expect(
      inspectApplicationAccessPage({
        browserRuntime,
        request: {
          ...request,
          scope: { type: "discovery_source", source: "target_site" },
        } as unknown as UserActionRequest,
      }),
    ).resolves.toBe("unavailable");
    expect(browserRuntime.readApplicationPageBinding).not.toHaveBeenCalled();
  });
});
