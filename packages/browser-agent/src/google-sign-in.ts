import type { ApplyFrameOwner } from "@nestor/contracts";
import type { ApplyFormObservation } from "./apply/types";

export const GOOGLE_ACCOUNT_WINDOW_ORIGINS = [
  "https://accounts.google.com",
] as const;
export type GoogleIdentityContext = {
  intendedEmail: string | null;
  /** The sole offered account selected in this flow when Profile has no email. */
  selectedEmail?: string | null;
  entry: "basic" | "unproven";
  fenced: boolean;
};
const GOOGLE_BUTTON =
  /\b(?:continue|sign\s?in|log\s?in|sign\s?up|register)\b/iu;
const GOOGLE_NAME = /\bgoogle\b/iu;
const CHOOSER_PATHS = new Set(["accountchooser", "oauthchooseaccount"]);
const ACCOUNT_EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const BASIC_SCOPES = new Set([
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
]);
const GIS_ID_TOKEN_PARAMETERS = new Set([
  "client_id",
  "response_type",
  "redirect_uri",
  "nonce",
  "state",
  "ux_mode",
  "login_hint",
  "context",
]);
export const normalizeGoogleEmail = (
  value: string | null | undefined,
): string => (value ?? "").trim().toLowerCase();
type Item =
  | ApplyFormObservation["actions"][number]
  | ApplyFormObservation["links"][number]
  | ApplyFormObservation["clickables"][number];
const items = (page: ApplyFormObservation): Item[] => [
  ...page.actions,
  ...page.links,
  ...page.clickables,
];
const emails = (text: string): string[] =>
  [...text.matchAll(ACCOUNT_EMAIL)].map((match) =>
    normalizeGoogleEmail(match[0]),
  );
const available = (item: Item) =>
  item.visible &&
  !("disabled" in item && item.disabled) &&
  !("kind" in item && item.kind === "final");
function pageUrl(page: Pick<ApplyFormObservation, "url">): URL | null {
  try {
    return new URL(page.url ?? "");
  } catch {
    return null;
  }
}
export function isGoogleAccountPage(
  page: Pick<ApplyFormObservation, "url">,
): boolean {
  return pageUrl(page)?.hostname === "accounts.google.com";
}
function owner(
  page: ApplyFormObservation,
  item: { frame?: ApplyFrameOwner },
): ApplyFrameOwner {
  const url = pageUrl(page);
  return (
    item.frame ??
    (url && !url.username && !url.password
      ? { origin: url.origin, pathname: url.pathname }
      : { origin: "null", pathname: "" })
  );
}
export function googleAccountWindowReady(
  page: ApplyFormObservation,
  ctx?: GoogleIdentityContext,
): boolean {
  const surface = page.accountWindow;
  return (
    (!ctx?.fenced || !isGoogleAccountPage(page) || !!surface) &&
    (!surface ||
      (surface.origin === GOOGLE_ACCOUNT_WINDOW_ORIGINS[0] && !surface.refusal))
  );
}
function ready(
  page: ApplyFormObservation,
  ctx?: GoogleIdentityContext,
): ctx is GoogleIdentityContext {
  const url = pageUrl(page);
  return (
    !!ctx &&
    url?.origin === GOOGLE_ACCOUNT_WINDOW_ORIGINS[0] &&
    !url.username &&
    !url.password &&
    !page.loading &&
    page.blocker?.code !== "multi_factor_required" &&
    googleAccountWindowReady(page, ctx)
  );
}
function chooser(
  page: ApplyFormObservation,
  ctx?: GoogleIdentityContext,
): boolean {
  return (
    ready(page, ctx) &&
    CHOOSER_PATHS.has(
      pageUrl(page)!.pathname.split("/").at(-1)?.toLowerCase() ?? "",
    ) &&
    !page.controls.some(
      (control) =>
        control.visible &&
        (control.credentialRole || control.kind === "checkbox"),
    )
  );
}
export function googleChooserAccount(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): string | null {
  if (!chooser(page, ctx)) return null;
  const target = normalizeGoogleEmail(ctx!.intendedEmail);
  const accounts = items(page).filter(
    (item) => !item.frame && available(item) && emails(item.label).length > 0,
  );
  if (!target) {
    const account = accounts[0];
    return accounts.length === 1 &&
      !!account &&
      account.ref === ref &&
      !/\bsigned\s*out\b/iu.test(account.label) &&
      emails(account.label).length === 1
      ? (emails(account.label).at(0) ?? null)
      : null;
  }
  const matches = accounts.filter(
    (item) =>
      !item.frame && available(item) && emails(item.label).includes(target),
  );
  const item = matches[0];
  return matches.length === 1 &&
    !!item &&
    item.ref === ref &&
    emails(item.label).length === 1
    ? target
    : null;
}
/** A single navigation to the identifier step, never selection of another identity. */
export function googleUseAnotherAccount(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): boolean {
  if (!ctx?.intendedEmail || !chooser(page, ctx)) return false;
  if (
    items(page).some(
      (item) =>
        available(item) &&
        emails(item.label).includes(normalizeGoogleEmail(ctx.intendedEmail)),
    )
  )
    return false;
  const choices = items(page).filter(
    (item) =>
      !item.frame &&
      available(item) &&
      /^use another account$/iu.test(item.label.trim()),
  );
  return choices.length === 1 && choices[0]?.ref === ref;
}
export function googleIdentifierStep(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): boolean {
  if (
    !ready(page, ctx) ||
    !ctx.intendedEmail ||
    !/^\/(?:v\d+\/)?signin\/(?:v\d+\/)?identifier\/?$/u.test(
      pageUrl(page)!.pathname,
    )
  )
    return false;
  const controls = page.controls.filter((control) => control.visible);
  const identifiers = controls.filter(
    (control) => control.credentialRole === "identifier",
  );
  const identifier = identifiers[0];
  return (
    identifiers.length === 1 &&
    !!identifier &&
    identifier.ref === ref &&
    !identifier.frame &&
    !identifier.disabled &&
    !identifier.readOnly &&
    !controls.some(
      (control) =>
        control.credentialRole === "password" ||
        control.credentialRole === "one_time_code" ||
        control.kind === "checkbox",
    )
  );
}
export function googleIdentifierNext(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): boolean {
  const control = page.controls.find((control) =>
    googleIdentifierStep(page, control.ref, ctx),
  );
  const next = items(page).filter(
    (item) =>
      !item.frame && available(item) && /^next$/iu.test(item.label.trim()),
  );
  return (
    !!control &&
    control.answered &&
    normalizeGoogleEmail(control.value) ===
      normalizeGoogleEmail(ctx?.intendedEmail) &&
    next.length === 1 &&
    next[0]?.ref === ref
  );
}
export function googleBasicConfirmation(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): string | null {
  if (
    !ready(page, ctx) ||
    ctx.entry !== "basic" ||
    !/^\/(?:signin\/oauth\/|gsi\/)/u.test(pageUrl(page)!.pathname) ||
    page.controls.some((control) => control.visible && !control.disabled)
  )
    return null;
  const shown = new Set(
    emails(
      [...items(page).map((item) => item.label), page.bodyTextExcerpt].join(
        " ",
      ),
    ),
  );
  const confirm = items(page).filter(
    (item) =>
      !item.frame &&
      available(item) &&
      /^(?:continue|confirm|allow)$/iu.test(item.label.trim()),
  );
  const target = normalizeGoogleEmail(ctx.intendedEmail ?? ctx.selectedEmail);
  return shown.size === 1 &&
    shown.has(target) &&
    confirm.length === 1 &&
    confirm[0]?.ref === ref
    ? target
    : null;
}
const OFFER_DECLINE =
  /^(?:not now|skip|maybe later|no thanks|remind me later)$/iu;
/** Where Google asks for a credential, a code or consent: never stepped around. */
const CREDENTIAL_OR_CONSENT_PATH =
  /(?:^|\/)(?:challenge|identifier|oauth|gsi|pwd|totp|ipp|pk|sk|webauthn)(?:\/|$)/iu;
/**
 * Declining an optional Google offer that interrupts the flow, such as
 * creating a passkey: the offer's own Not now or Skip, on a page that asks for
 * no credential, code, choice or other identity and is not a consent page.
 * Accepting the offer, or any passkey sign-in, stays with the person.
 */
export function googleOptionalOfferDecline(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): boolean {
  if (!ready(page, ctx) || chooser(page, ctx)) return false;
  if (CREDENTIAL_OR_CONSENT_PATH.test(pageUrl(page)!.pathname)) return false;
  if (page.controls.some((control) => control.visible)) return false;
  const target = normalizeGoogleEmail(ctx.intendedEmail ?? ctx.selectedEmail);
  if (!target) return false;
  const shown = emails(
    [...items(page).map((item) => item.label), page.bodyTextExcerpt].join(" "),
  );
  if (shown.some((email) => email !== target)) return false;
  const declines = items(page).filter(
    (item) =>
      !item.frame && available(item) && OFFER_DECLINE.test(item.label.trim()),
  );
  return declines.length === 1 && declines[0]?.ref === ref;
}
/**
 * Host, path and parameter names of the recorded authorization entries, for
 * an unproven handoff and its audit. Ordinary account pages (the chooser, a
 * consent page) are not authorization entries and are left out. Never a
 * parameter value, fragment or credential.
 */
export function googleEntryShape(entries: readonly string[] | null): string {
  const shapes = new Set<string>();
  for (const entry of entries ?? []) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      shapes.add("an entry that could not be recorded");
      continue;
    }
    if (
      !/^\/o\/oauth2\//u.test(url.pathname) &&
      !url.pathname.startsWith("/gsi/") &&
      !["scope", "access_type", "include_granted_scopes", "response_type"].some(
        (key) => url.searchParams.has(key),
      )
    )
      continue;
    const path = url.pathname
      .split("/")
      .map((part) =>
        !part || /^[a-z0-9_.-]{1,32}$/iu.test(part) ? part : ":id",
      )
      .join("/");
    const keys = [
      ...new Set(
        [...url.searchParams.keys()].map((key) =>
          /^[a-z0-9_.-]{1,40}$/iu.test(key) ? key : "[other]",
        ),
      ),
    ].sort();
    shapes.add(
      `${url.host}${path}${keys.length ? ` (${keys.join(", ")})` : ""}`,
    );
  }
  return shapes.size
    ? [...shapes].slice(0, 4).join("; ")
    : "no Google authorization entry";
}
/** Transient authorization evidence, never a URL to expose to a model or persist. */
export function googleFlowEntry(
  entries: string | readonly string[] | null,
): "basic" | "unproven" {
  let basic = false;
  for (const entry of typeof entries === "string"
    ? [entries]
    : (entries ?? [])) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return "unproven";
    }
    if (
      url.origin !== GOOGLE_ACCOUNT_WINDOW_ORIGINS[0] ||
      url.username ||
      url.password
    )
      return "unproven";
    const query = url.searchParams;
    const authorization = /^\/o\/oauth2\/(?:v2\/)?auth$/u.test(url.pathname);
    const gis = url.pathname === "/gsi/select";
    const scopeBearing = [
      "scope",
      "access_type",
      "include_granted_scopes",
      "response_type",
    ].some((key) => query.has(key));
    if (!authorization && !gis) {
      if (scopeBearing || url.pathname.startsWith("/gsi/")) return "unproven";
      continue; // Ordinary account navigation is not evidence of granted scope.
    }
    if (
      [
        "scope",
        "access_type",
        "include_granted_scopes",
        "response_type",
        "client_id",
      ].some((key) => query.getAll(key).length > 1)
    )
      return "unproven";
    if (
      (query.has("access_type") &&
        query.get("access_type")?.trim().toLowerCase() !== "online") ||
      (query.has("include_granted_scopes") &&
        query.get("include_granted_scopes")?.trim().toLowerCase() !== "false")
    )
      return "unproven";
    if (gis) {
      // Only an explicitly ID-token entry with audited parameters is supported.
      // An arbitrary /gsi/* path, or missing scope text, is not proof.
      if (
        !query.get("client_id") ||
        query.get("response_type") !== "id_token" ||
        [...query.keys()].some((key) => !GIS_ID_TOKEN_PARAMETERS.has(key))
      )
        return "unproven";
    } else {
      const scopes = (query.get("scope") ?? "")
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      if (!scopes.length || scopes.some((scope) => !BASIC_SCOPES.has(scope)))
        return "unproven";
    }
    basic = true;
  }
  return basic ? "basic" : "unproven";
}
export function googleSignInInteraction(
  page: ApplyFormObservation,
  ref: string | undefined,
  ctx?: GoogleIdentityContext,
): "googleSignIn" | "google_handoff" | null {
  if (!googleAccountWindowReady(page, ctx)) return "google_handoff";
  const item = items(page).find((item) => item.ref === ref);
  const document = owner(page, item ?? {});
  let googleOwner = false;
  try {
    googleOwner = new URL(document.origin).hostname === "accounts.google.com";
  } catch {
    /* Invalid origins never grant access. */
  }
  if (!isGoogleAccountPage(page) && !googleOwner) {
    if (!item || !available(item) || page.loading) return null;
    return /^(?:google|google account)$/iu.test(item.label.trim()) ||
      (GOOGLE_NAME.test(item.label) && GOOGLE_BUTTON.test(item.label))
      ? "googleSignIn"
      : null;
  }
  if (
    item &&
    available(item) &&
    !page.loading &&
    document.origin === GOOGLE_ACCOUNT_WINDOW_ORIGINS[0] &&
    document.pathname === "/gsi/button" &&
    page.blocker?.code !== "multi_factor_required" &&
    !page.controls.some((control) => {
      const controlOwner = owner(page, control);
      return (
        control.visible &&
        control.credentialRole &&
        controlOwner.origin === document.origin &&
        controlOwner.pathname === document.pathname
      );
    })
  )
    return "googleSignIn";
  return googleChooserAccount(page, ref, ctx) ||
    googleIdentifierStep(page, ref, ctx) ||
    googleIdentifierNext(page, ref, ctx) ||
    googleBasicConfirmation(page, ref, ctx) ||
    googleUseAnotherAccount(page, ref, ctx) ||
    googleOptionalOfferDecline(page, ref, ctx)
    ? "googleSignIn"
    : "google_handoff";
}
export function hasGoogleSignInAction(
  page: ApplyFormObservation,
  ctx?: GoogleIdentityContext,
): boolean {
  return [...items(page), ...page.controls].some(
    (item) => googleSignInInteraction(page, item.ref, ctx) === "googleSignIn",
  );
}
