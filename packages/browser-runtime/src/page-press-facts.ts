import type {
  ApplyClickFacts,
  SubmissionActionRequest,
} from "@nestor/contracts";
import type { Page, Request, Response } from "playwright";
import { readPageMutationResponseText } from "./mutation-response-body";
import { rememberApplicationSubmitRequest } from "./attachment-upload-ledger";

/** Observe a press without deciding what it means or changing its execution. */
export function watchPagePress(
  page: Page,
  options?: { applicationSend: boolean },
): { finish: () => Promise<ApplyClickFacts> } {
  const readPage = () => {
    try {
      const url = new URL(page.url());
      return { origin: url.origin, safePath: url.pathname };
    } catch {
      return { origin: null, safePath: null };
    }
  };
  const pageBefore = readPage();
  const requests: SubmissionActionRequest[] = [];
  const byRequest = new Map<Request, SubmissionActionRequest>();
  const responseReads: Promise<void>[] = [];
  const readResponse = async (
    entry: SubmissionActionRequest,
    response: Response | null,
  ) => {
    if (!response) return;
    entry.status = response.status();
    if (entry.status >= 400)
      entry.responseText = await readPageMutationResponseText(page, response);
  };
  const onRequest = (request: Request) => {
    if (options?.applicationSend) rememberApplicationSubmitRequest(request);
    try {
      const url = new URL(request.url());
      const entry: SubmissionActionRequest = {
        method: request.method(),
        host: url.host,
        path: url.pathname,
        status: null,
        failure: null,
        finalSubmit: false,
      };
      requests.push(entry);
      byRequest.set(request, entry);
      // A fetch may answer after the click settles. Keep that request's answer
      // in the result too; response headers alone do not include its reason.
      if (!["GET", "HEAD", "OPTIONS"].includes(entry.method))
        responseReads.push(
          request
            .response()
            .then((response) => readResponse(entry, response))
            .catch(() => {
              /* An unreadable response has only its status/failure. */
            }),
        );
    } catch {
      /* A non-URL request has no host/path to report. */
    }
  };
  const onResponse = (response: Response) => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    entry.status = response.status();
  };
  const onFailure = (request: Request) => {
    const entry = byRequest.get(request);
    if (entry) entry.failure = request.failure()?.errorText ?? "failed";
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailure);
  return {
    finish: async () => {
      page.off("request", onRequest);
      try {
        await Promise.all(responseReads);
      } finally {
        page.off("response", onResponse);
        page.off("requestfailed", onFailure);
      }
      const pageAfter = readPage();
      return {
        pageBefore,
        pageAfter,
        urlChanged:
          pageBefore.origin !== pageAfter.origin ||
          pageBefore.safePath !== pageAfter.safePath,
        requestsAfterClick: requests,
      };
    },
  };
}
