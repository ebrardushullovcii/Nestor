import process from "node:process";
import { redactVerificationText } from "./verification-privacy.mjs";

const OMITTED = "[secret omitted]";
// A path step that hands whoever holds the link an account: activation,
// email verification, password reset, magic sign-in and invitation links.
const ONE_TIME_STEP =
  /^(?:activat\w*|verif\w*|confirm\w*|reset\w*|set[-_]?password|password[-_]?reset|passwordreset|magic(?:[-_]?link)?|invit\w*|accept[-_]?invit\w*|passwordless|login[-_]?link|email[-_]?login|unlock|recover\w*)$/i;
// Query or fragment names whose value is such a token.
const ONE_TIME_PARAM =
  /^(?:\w*token|\w*[_-]?secret|sig|signature|otp|nonce|ticket|jwt|auth|hash|session(?:[_-]?id)?|activation\w*|verification\w*|verify\w*|confirm\w*|reset\w*|magic\w*|invit\w*|(?:auth|login|otp|confirmation|activation|reset|magic)[_-]?code)$/i;
const charClass = (c) => (c >= "a" ? 0 : c >= "A" ? 1 : 2);
/**
 * A long random value without a telling name: 64 or more characters of upper
 * and lower case letters and digits that change class from one character to
 * the next about as often as random text does. Job slugs, titles and ids
 * (words, numbers, UUIDs, hex page ids, Workday titles such as
 * Software-Engineer_R-100576, 43-character board ids) stay readable.
 */
const opaqueToken = (value) => {
  if (
    value.length < 64 ||
    !/^[A-Za-z0-9_~.=+-]+$/.test(value) ||
    !/[a-z]/.test(value) ||
    !/[A-Z]/.test(value) ||
    !/\d/.test(value)
  )
    return false;
  let pairs = 0;
  let changes = 0;
  // Words and hex ids (one case) are not counted: only mixed-case runs.
  for (const run of value.split(/[^A-Za-z0-9]+/))
    for (
      let i = /[a-z]/.test(run) && /[A-Z]/.test(run) ? 1 : run.length;
      i < run.length;
      i++
    ) {
      pairs++;
      if (charClass(run[i]) !== charClass(run[i - 1])) changes++;
    }
  return pairs >= 48 && changes / pairs >= 0.3;
};
const decodeName = (name) => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};
/** One URL with its one-time tokens masked; everything else kept as written. */
function redactLinkTokens(url) {
  const parts = /^(https?:\/\/[^/?#]*)([^?#]*)(.*)$/is.exec(url);
  if (!parts) return url;
  const [, origin, pathPart, rest] = parts;
  const segments = pathPart.split("/");
  let afterStep = 0;
  for (const [i, segment] of segments.entries()) {
    if (ONE_TIME_STEP.test(segment)) {
      afterStep = 2;
      continue;
    }
    if (
      opaqueToken(segment) ||
      (afterStep > 0 && segment.length >= 6 && /[\dA-Z]/.test(segment))
    )
      segments[i] = OMITTED;
    if (segment && afterStep > 0) afterStep--;
  }
  const tail = rest.replace(
    /([?&#;])([^=&#;]+)=([^&#;]*)/g,
    (all, separator, name, value) =>
      value &&
      value !== OMITTED &&
      (ONE_TIME_PARAM.test(decodeName(name)) || opaqueToken(value))
        ? `${separator}${name}=${OMITTED}`
        : all,
  );
  return origin + segments.join("/") + tail;
}
/** Never retain authentication material or private model continuation state. */
export function traceSafe(value) {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, val]) =>
        /(?:KEY|TOKEN|SECRET|PASSWORD|MFA_CODE)$/i.test(key) &&
        val &&
        val.length > 3,
    )
    // A value counts where it stands as its own token, never inside a longer
    // word: Windows CI sets PGPASSWORD=root, which must not turn "shadow-root"
    // in a tool description into "shadow-[secret omitted]".
    .map(
      ([, val]) =>
        new RegExp(
          `(?<![\\p{L}\\p{N}_-])${val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
          "gu",
        ),
    );
  const cleanText = (text) => {
    text = redactVerificationText(text);
    for (const secret of secrets)
      text = text.replace(secret, "[secret omitted]");
    return (
      text
        .replace(/\bhttps?:\/\/[^\s"'<>\\`]+/gi, redactLinkTokens)
        .replace(/Bearer\s+[^\s"']+/gi, "Bearer [secret omitted]")
        .replace(
          /([?&](?:access_token|id_token|token|code|key|api_key|password)=)[^&#\s"']*/gi,
          "$1[secret omitted]",
        )
        // URL userinfo only: never span quotes or JSON punctuation into a
        // neighbouring field such as an email address.
        .replace(
          /(https?:\/\/)[^\s/@:"'<>{},]+:[^\s/@"'<>{},]+@/gi,
          "$1[secret omitted]@",
        )
    );
  };
  const visit = (item) => {
    if (typeof item === "string") {
      // Tool arguments and DB JSON columns are often serialized JSON.
      if (/^\s*[[{]/.test(item)) {
        try {
          const parsed = JSON.parse(item);
          const cleaned = visit(parsed);
          return JSON.stringify(parsed) === JSON.stringify(cleaned)
            ? cleanText(item)
            : JSON.stringify(cleaned);
        } catch {
          /* prose */
        }
      }
      return cleanText(item);
    }
    if (Array.isArray(item))
      return item
        .filter(
          (v) =>
            !v ||
            typeof v !== "object" ||
            !("type" in v) ||
            v.type !== "reasoning",
        )
        .map(visit);
    if (!item || typeof item !== "object") return item;
    if (item instanceof Error)
      return { name: item.name, message: cleanText(item.message) };
    const record = item;
    if (
      typeof record.type === "string" &&
      /reasoning.*(?:delta|done)/i.test(record.type)
    )
      return { type: record.type, omitted: "private reasoning" };
    // A fill command naming a secret control must not record its value.
    const secretControl =
      /password|one.time|verification.code|mfa|otp|token|csrf|sessionid/i.test(
        [
          record.name,
          record.label,
          record.autocomplete,
          record.credentialRole,
          record.type,
          record.kind,
        ]
          .filter((v) => typeof v === "string")
          .join(" "),
      );
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key, val]) => {
          if (/^(?:reasoning_content|encrypted_content)$/i.test(key))
            return false;
          return !(
            key === "continuation" &&
            val &&
            typeof val === "object" &&
            val.kind === "reasoning_content"
          );
        })
        .map(([key, val]) => [
          key,
          (/^(?:authorization|cookies?|set-cookie|password|passwd|access_token|refresh_token|id_token|api_key|apiKey|secret|mfaCode|otp)$/i.test(
            key,
          ) &&
            !(
              val &&
              typeof val === "object" &&
              typeof val.type === "string" &&
              ["string", "object", "array", "number", "boolean"].includes(
                val.type,
              )
            )) ||
          (secretControl && /^(?:value|text|answer)$/i.test(key))
            ? "[secret omitted]"
            : visit(val),
        ]),
    );
  };
  return visit(value);
}
