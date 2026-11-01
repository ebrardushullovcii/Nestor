// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installPasswordPage } from "./password-page";
import type { BrowserPasswordFill } from "@nestor/contracts";
import { readPasswordForms } from "../main/services/browser/password-form";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([
  '<form><input type="password" autocomplete="current-password"><button>Delete account</button></form>',
  '<h1>Create account</h1><form><input type="password"><button>Continue</button></form>',
  '<form><input type="password" autocomplete="current-password"><button>Continue</button></form>',
  '<form><input type="password" autocomplete="current-password" style="visibility:hidden"><button>Sign in</button></form>',
])(
  "rejects ambiguous, destructive, registration and hidden forms for agent sign-in",
  (html) => {
    const { fill, value, port } = setup(html);
    expect(readPasswordForms().some((form) => form.login)).toBe(false);
    fill({ ...value, agent: true });
    expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  },
);
function setup(
  html = '<form action="/session"><input autocomplete="username" name="username"><input type="password" autocomplete="current-password"><button>Sign in</button></form>',
) {
  document.body.innerHTML = html;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 100 },
  ] as unknown as DOMRectList);
  const events = new Map<string, EventListener>();
  vi.spyOn(document, "addEventListener").mockImplementation(
    (name, listener) => {
      events.set(name, listener as EventListener);
    },
  );
  const port = {
    capture:
      vi.fn<
        (value: {
          origin: string;
          action: string;
          username: string;
          password: string;
        }) => void
      >(),
    filled: vi.fn(),
    onFill: vi.fn<(listener: (value: BrowserPasswordFill) => void) => void>(),
  };
  installPasswordPage(port);
  const fill = port.onFill.mock.calls[0]![0];
  const value = {
    requestId: "opaque",
    origin: location.origin,
    username: "synthetic-user",
    password: "synthetic-secret",
    agent: false,
  };
  return { port, events, fill, value };
}
it("automatically captures typed login and new-account credentials without exposing a website bridge", () => {
  vi.useFakeTimers();
  const { events, port } = setup(
    '<form><input autocomplete="username" value="synthetic"><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"><button>Create account</button></form>',
  );
  const fields = document.querySelectorAll<HTMLInputElement>(
    'input[type="password"]',
  );
  fields[0]!.value = "synthetic-new-account";
  events.get("input")!({
    isTrusted: true,
    target: fields[0],
  } as unknown as Event);
  vi.advanceTimersByTime(1200);
  expect(port.capture.mock.calls.length).toBe(1);
  expect(port.capture.mock.calls[0]?.[0].password === fields[0]!.value).toBe(
    true,
  );
  expect("nestor" in window).toBe(false);
  expect(readPasswordForms().every((form) => !form.login)).toBe(true);
});
it("fills normally with input/change events, and refuses changed origin or registration during agent use", () => {
  const { fill, value, port } = setup();
  const changes = vi.fn();
  document
    .querySelector('input[type="password"]')!
    .addEventListener("change", changes);
  fill(value);
  expect(
    (document.querySelector('input[type="password"]') as HTMLInputElement)
      .value === value.password,
  ).toBe(true);
  expect(changes).toHaveBeenCalledOnce();
  expect(port.filled).toHaveBeenLastCalledWith("opaque", true);
  fill({ ...value, origin: "https://other.test" });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  (
    document.querySelector('input[type="password"]') as HTMLInputElement
  ).autocomplete = "new-password";
  fill({ ...value, agent: true });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
});
it("rejects cross-origin form actions and submitter overrides before sending any secret to the DOM", () => {
  const { fill, value, port } = setup(
    '<form action="https://other.test"><input name="username"><input type="password"><button>Sign in</button></form>',
  );
  fill(value);
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(
    (document.querySelector('input[type="password"]') as HTMLInputElement).value
      .length,
  ).toBe(0);
  document.querySelector("form")!.action = "/session";
  document
    .querySelector("button")!
    .setAttribute("formaction", "https://other.test");
  fill(value);
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(readPasswordForms()[0]?.action).toBe("https://other.test/");
});
it("rechecks form binding after username listeners run and never logs DOM exceptions", () => {
  const { fill, value, port } = setup();
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  document
    .querySelector('input[name="username"]')!
    .addEventListener("input", () => {
      document.querySelector("form")!.action = "https://other.test";
    });
  fill(value);
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(
    (document.querySelector('input[type="password"]') as HTMLInputElement).value
      .length,
  ).toBe(0);
  expect(log).not.toHaveBeenCalled();
});
it("fills the sign-in dialog above registration without touching its background credentials", () => {
  const { fill, value, port } = setup(`
    <h1>Create an Account</h1>
    <form id="registration"><input type="email"><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"><button>Create Account</button></form>
    <div role="dialog" aria-modal="true"><h2>Sign In</h2>
      <form id="login" action="/session"><input type="email"><input type="password"><button>Sign In</button></form>
    </div>`);
  expect(readPasswordForms()).toEqual([
    {
      action: new URL("/session", location.href).href,
      login: true,
      passwordIndex: 2,
    },
  ]);
  fill({
    ...value,
    agent: true,
    username: "",
    fallbackUsername: "synthetic-applicant@example.test",
  });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", true);
  expect(
    document.querySelector<HTMLInputElement>('#login input[type="email"]')
      ?.value,
  ).toBe("synthetic-applicant@example.test");
  expect(
    document.querySelector<HTMLInputElement>('#login input[type="password"]')
      ?.value === value.password,
  ).toBe(true);
  expect(
    Array.from(
      document.querySelectorAll<HTMLInputElement>("#registration input"),
    ).every((input) => !input.value),
  ).toBe(true);
});
it("keeps existing usernames on manual password-only fills and refuses conflicting or unavailable profile identities for agent fills", () => {
  const { fill, value, port } = setup();
  const username =
    document.querySelector<HTMLInputElement>('[name="username"]')!;
  const password =
    document.querySelector<HTMLInputElement>('[type="password"]')!;
  username.value = "synthetic-other@example.test";
  fill({ ...value, username: "" });
  expect(username.value).toBe("synthetic-other@example.test");
  expect(port.filled).toHaveBeenLastCalledWith("opaque", true);
  password.value = "";
  fill({
    ...value,
    agent: true,
    username: "",
    fallbackUsername: "synthetic-applicant@example.test",
  });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(password.value).toBe("");
  username.value = "";
  fill({ ...value, agent: true, username: "" });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(password.value).toBe("");
});
it("does not fill registration dialogs or choose between multiple sign-in dialogs", () => {
  const { fill, value, port } = setup(`
    <div role="dialog"><h2>Create account</h2><form><input type="password"><button>Sign In</button></form></div>`);
  fill({ ...value, agent: true });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  document.body.innerHTML = `<div role="dialog"><h2>Sign In</h2><input type="password"><button>Sign In</button></div><div role="dialog"><h2>Sign In</h2><input type="password"><button>Sign In</button></div>`;
  fill({ ...value, agent: true });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(
    Array.from(
      document.querySelectorAll<HTMLInputElement>('[type="password"]'),
    ).every((input) => !input.value),
  ).toBe(true);
});
it("keeps a form-less modal's username and login intent inside that modal", () => {
  const { fill, value, port } = setup(`
    <form><h1>Create account</h1><input type="email"><input type="password" autocomplete="new-password"><button>Create Account</button>
      <div role="dialog"><h2>Sign In</h2><input type="email"><input type="password"><button>Sign In</button></div>
    </form>`);
  expect(readPasswordForms()[0]?.login).toBe(true);
  fill({ ...value, agent: true });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", true);
  expect(
    document.querySelector<HTMLInputElement>('form > input[type="email"]')
      ?.value,
  ).toBe("");
  expect(
    document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[type="email"]',
    )?.value,
  ).toBe(value.username);
});
it("rechecks login intent if entering the email changes the page into account creation", () => {
  const { fill, value, port } = setup();
  const password =
    document.querySelector<HTMLInputElement>('[type="password"]')!;
  document.querySelector('[name="username"]')!.addEventListener("input", () => {
    password.autocomplete = "new-password";
    document.querySelector("button")!.textContent = "Create account";
  });
  fill({ ...value, agent: true });
  expect(port.filled).toHaveBeenLastCalledWith("opaque", false);
  expect(password.value).toBe("");
});
it.each(["email", "section-signin email"])(
  "captures and fills a text email field identified only by autocomplete=%s inside a Workday-style modal",
  (autocomplete) => {
    // Public FMR DOM shape: duplicate generated ids; registration hidden with
    // aria-hidden; email is type=text, has no name and only autocomplete=email;
    // Create Account/Forgot password are outside the modal's actual form.
    const { fill, value, port, events } = setup(`
      <div aria-hidden="true"><h3>Create Account</h3><form><input type="text" autocomplete="email" id="input-4"><input type="password" autocomplete="new-password" id="input-5"><input type="password" autocomplete="new-password" id="input-6"><button>Create Account</button></form></div>
      <div role="dialog" aria-modal="true"><h2>Sign In</h2><form><input type="text" autocomplete="${autocomplete}" id="input-4"><input type="password" autocomplete="current-password" id="input-5"><button type="submit">Sign In</button></form><button type="submit">Create Account</button><button type="submit">Forgot your password?</button></div>`);
    const dialog = document.querySelector('[role="dialog"]')!;
    const username =
      dialog.querySelector<HTMLInputElement>('input[type="text"]')!;
    const password = dialog.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!;
    expect(readPasswordForms()).toEqual([
      { action: location.href, login: true, passwordIndex: 2 },
    ]);
    const email = "synthetic-applicant@example.test";
    fill({ ...value, agent: true, username: "", fallbackUsername: email });
    expect(port.filled).toHaveBeenLastCalledWith("opaque", true);
    expect(username.value).toBe(email);
    expect(password.value === value.password).toBe(true);
    expect(
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          '[aria-hidden="true"] input',
        ),
      ).every((input) => input.value === ""),
    ).toBe(true);
    events.get("change")!({
      isTrusted: true,
      target: password,
    } as unknown as Event);
    expect(port.capture).toHaveBeenLastCalledWith(
      expect.objectContaining({ username: email }),
    );
  },
);
