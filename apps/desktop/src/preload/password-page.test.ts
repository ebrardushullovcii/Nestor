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
