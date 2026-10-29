import { expect, it } from "vitest";
import {
  BrowserPasswordAutofillInputSchema,
  BrowserPasswordPromptInputSchema,
  BrowserPasswordsListInputSchema,
  DesktopBrowserStateSchema,
  DesktopBrowserImportSourceSchema,
  BrowserSignInSourcesSchema,
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

it("keeps password import capability separate from sign-ins and out of assistant source metadata", () => {
  const source = DesktopBrowserImportSourceSchema.parse({
    id: "opaque",
    browser: "edge",
    browserLabel: "Microsoft Edge",
    profileLabel: "Profile 1",
    supported: false,
    note: "Sign in directly.",
    passwordImport: { supported: true, note: null },
  });
  expect(source.supported).toBe(false);
  expect(source.passwordImport.supported).toBe(true);
  const assistant = BrowserSignInSourcesSchema.parse({
    sources: [source],
    note: null,
  });
  expect(assistant.sources[0]).not.toHaveProperty("passwordImport");
  expect(assistant.sources[0]).not.toHaveProperty("id");
});
