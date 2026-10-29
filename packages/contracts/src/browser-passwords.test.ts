import { expect, it } from "vitest";
import {
  BrowserPasswordAutofillInputSchema,
  BrowserPasswordPromptInputSchema,
  BrowserPasswordsListInputSchema,
  DesktopBrowserStateSchema,
} from "./index";
it("password commands accept only opaque identifiers, never app-supplied passwords or origins", () => {
  expect(
    BrowserPasswordPromptInputSchema.safeParse({ promptId: "offer" }).success,
  ).toBe(true);
  expect(
    BrowserPasswordPromptInputSchema.safeParse({
      promptId: "offer",
      password: "spoof",
    }).success,
  ).toBe(false);
  expect(
    BrowserPasswordAutofillInputSchema.safeParse({
      tabId: "tab",
      credentialId: "account",
      origin: "https://spoof.test",
    }).success,
  ).toBe(false);
  expect(
    BrowserPasswordsListInputSchema.safeParse({ path: "arbitrary-file" })
      .success,
  ).toBe(false);
  expect(
    "password" in
      DesktopBrowserStateSchema.shape.passwordPrompt.unwrap().unwrap().shape,
  ).toBe(false);
});
