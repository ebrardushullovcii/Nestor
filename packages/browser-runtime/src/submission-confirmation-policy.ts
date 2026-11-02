import {
  applicationSubmissionConfirmationMessages,
  hasApplicationSubmissionRefusal,
} from "@nestor/contracts";
import { readGraphQlRequest } from "./graphql-request";

export interface SubmissionPageState {
  url: string;
  text: string;
  ready: boolean;
  editableControls: number;
}

/** Identify a final operation, never a fact inside its answers or variables. */
export function isFinalSubmissionRequest(input: {
  url: string;
  method: string;
  body: string | null;
  mainFrame: boolean;
  navigation: boolean;
  allowedOrigins: ReadonlySet<string>;
  nativeAction: {
    origin: string | null;
    safePath: string | null;
    /** Transient binding only; query values never enter diagnostics. */
    query?: string;
    method?: string;
  } | null;
}): boolean {
  if (!input.mainFrame) return false;
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return false;
  }
  if (!input.allowedOrigins.has(url.origin)) return false;
  const nativeEndpoint =
    input.nativeAction?.origin === url.origin &&
    input.nativeAction.safePath === url.pathname;
  if (
    nativeEndpoint &&
    input.nativeAction &&
    ((input.navigation &&
      input.nativeAction.method !== undefined &&
      input.nativeAction.method !== input.method) ||
      (input.method === "POST" &&
        input.nativeAction.query !== undefined &&
        input.nativeAction.query !== url.search))
  )
    return false;
  if (
    input.navigation &&
    ["GET", "POST"].includes(input.method) &&
    input.nativeAction?.origin === url.origin &&
    input.nativeAction.safePath === url.pathname &&
    (!input.nativeAction.method ||
      input.nativeAction.method === input.method) &&
    (input.method === "GET" ||
      input.nativeAction.query === undefined ||
      input.nativeAction.query === url.search)
  )
    return true;
  if (!["POST", "PUT", "PATCH"].includes(input.method)) return false;
  const operations = readGraphQlRequest(input.body);
  if (operations) {
    const operation = operations[0];
    if (
      operations.length !== 1 ||
      operation?.type !== "mutation" ||
      operation.rootFields.length !== 1
    )
      return false;
    const name = operation.rootFields[0]!.name.value.replace(
      /([a-z0-9])([A-Z])/gu,
      "$1 $2",
    )
      .replace(/[_-]/gu, " ")
      .toLowerCase();
    return (
      /\b(?:submit|apply|finish|complete|send|finalize|finalise)\b/u.test(
        name,
      ) && /\b(?:applications?|applicants?|candidates?|job)\b/u.test(name)
    );
  }
  // JS-enhanced native forms often fetch their own declared action. The
  // exact destination still binds the response to the selected final form.
  if (
    input.method === "POST" &&
    input.nativeAction?.origin === url.origin &&
    input.nativeAction.safePath === url.pathname &&
    (input.nativeAction.query === undefined ||
      input.nativeAction.query === url.search)
  )
    return true;
  // An opaque endpoint or collection create may be an autosave. Only an
  // explicit terminal action can provide response evidence for a JS form.
  return /\/(?:submit|apply|finish|complete|send)(?:[-_](?:application|confirmed))?\/?$/iu.test(
    url.pathname,
  );
}

/** A new employer acknowledgement, within the final action's origin scope. */
export function employerPageConfirmsSubmission(
  before: SubmissionPageState | null,
  after: SubmissionPageState,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!before || !after.ready) return false;
  let url: URL;
  try {
    url = new URL(after.url);
  } catch {
    return false;
  }
  if (!allowedOrigins.has(url.origin)) return false;
  if (hasApplicationSubmissionRefusal(after.text)) return false;
  const priorMessages = new Set(
    applicationSubmissionConfirmationMessages(before.text),
  );
  return applicationSubmissionConfirmationMessages(after.text).some(
    (message) => !priorMessages.has(message),
  );
}
