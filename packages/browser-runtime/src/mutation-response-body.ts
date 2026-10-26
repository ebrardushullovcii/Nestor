import type { Page, Response } from "playwright";
import { inspectMutationResponse } from "./mutation-response";

interface ObservedMutationResponse {
  method: string;
  url: string;
  requestBody: string;
  startedAt: number;
  status: number | null;
  text: string | null;
  claimedBy?: string;
}

/** Response bodies in Electron can be readable in the page before CDP finishes. */
export function installMutationResponseBodyObserver(): void {
  const target = window as unknown as Record<string, unknown>;
  if (target.__nestorMutationResponses) return;
  const entries: ObservedMutationResponse[] = [];
  target.__nestorMutationResponses = entries;
  const start = (method: string, url: string, body: unknown) => {
    if (!/^(?:POST|PUT|PATCH)$/u.test(method)) return null;
    const text =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : null;
    if (text === null || text.length > 64_000) return null;
    const entry: ObservedMutationResponse = {
      method,
      url: new URL(url, location.href).href,
      requestBody: text,
      startedAt: Date.now(),
      status: null,
      text: null,
    };
    entries.push(entry);
    entries.splice(0, Math.max(0, entries.length - 32));
    return entry;
  };
  const fetch = window.fetch.bind(window);
  window.fetch = async (resource, init) => {
    const request = resource instanceof Request ? resource : null;
    const entry = start(
      (init?.method ?? request?.method ?? "GET").toUpperCase(),
      resource instanceof Request
        ? resource.url
        : typeof resource === "string"
          ? resource
          : resource.href,
      init?.body,
    );
    const response = await fetch(resource, init);
    if (entry) {
      entry.status = response.status;
      const type = response.headers.get("content-type") ?? "";
      if (/json|^text\//iu.test(type)) {
        const copy = response.clone();
        void (async () => {
          const reader = copy.body?.getReader();
          if (!reader) {
            entry.text = "";
            return;
          }
          const decoder = new TextDecoder();
          let text = "",
            bytes = 0;
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) {
                entry.text = text + decoder.decode();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > 64_000) {
                await reader.cancel();
                return;
              }
              text += decoder.decode(chunk.value, { stream: true });
            }
          } catch {
            /* An unreadable body stays unconfirmed. */
          }
        })();
      }
    }
    return response;
  };
  const open = Reflect.get(XMLHttpRequest.prototype, "open");
  const send = Reflect.get(XMLHttpRequest.prototype, "send");
  const requests = new WeakMap<
    XMLHttpRequest,
    { method: string; url: string }
  >();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requests.set(this, { method: method.toUpperCase(), url: String(url) });
    Reflect.apply(open, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const request = requests.get(this);
    const entry = request ? start(request.method, request.url, body) : null;
    if (entry)
      this.addEventListener(
        "load",
        () => {
          entry.status = this.status;
          try {
            const text =
              this.responseType === "json"
                ? JSON.stringify(this.response)
                : this.responseType === "" || this.responseType === "text"
                  ? this.responseText
                  : null;
            if (text !== null && text.length <= 64_000) entry.text = text;
          } catch {
            /* An unreadable body stays unconfirmed. */
          }
        },
        { once: true },
      );
    return send.call(this, body);
  };
}

const requestTokens = new WeakMap<Response, string>();

/** Only a unique exact request observed on its own frame can supply a fallback body. */
export async function inspectPageMutationResponse(
  page: Page,
  response: Response,
) {
  let token = requestTokens.get(response);
  if (!token) {
    token = `${Date.now()}-${Math.random()}`;
    requestTokens.set(response, token);
  }
  const request = response.request();
  const requestBody = request.postData();
  const fallback = async (): Promise<string> => {
    if (requestBody === null || requestBody.length > 64_000)
      throw Error("Opaque request body");
    const frame = request.frame();
    if (frame.page() !== page) throw Error("Wrong page");
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const result = await frame.evaluate(
        (input) => {
          const entries = (window as unknown as Record<string, unknown>)
            .__nestorMutationResponses as
            | ObservedMutationResponse[]
            | undefined;
          const matches =
            entries?.filter(
              (entry) =>
                (!entry.claimedBy || entry.claimedBy === input.token) &&
                entry.method === input.method &&
                entry.url === input.url &&
                entry.requestBody === input.body &&
                Date.now() - entry.startedAt < 15_000,
            ) ?? [];
          if (matches.length !== 1) return null;
          const match = matches[0]!;
          if (match.status !== input.status || match.text === null) return null;
          match.claimedBy = input.token;
          return match.text;
        },
        {
          method: request.method(),
          url: request.url(),
          body: requestBody,
          status: response.status(),
          token,
        },
      );
      if (result !== null) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error("No unique readable response body");
  };
  return inspectMutationResponse({
    status: () => response.status(),
    headers: () => response.headers(),
    text: () => Promise.any([response.text(), fallback()]),
  });
}
