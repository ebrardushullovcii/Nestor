import type { Page } from "playwright";
import type { ApplyFormObservation } from "../apply/types";
import { htmlToPlainText, listingPageText } from "./listing-detail-extraction";

/** The same challenge detector for a read-only HTTP snapshot. */
export function blockedByCheck(html: string): boolean {
  const bodyTextExcerpt = listingPageText(html);
  // A page with more visible text than a challenge page has is not one; most
  // listing and board pages stop here, without a whitespace-collapsed copy.
  if (moreVisibleTextThan(bodyTextExcerpt, CHALLENGE_TEXT_LIMIT)) return false;
  return isBotCheckInterstitial({
    title: htmlToPlainText(
      html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "",
    ),
    bodyTextExcerpt,
    headings: [],
    controls: [],
    links: [],
  });
}

/** The most visible text a challenge page has, whitespace collapsed. */
const CHALLENGE_TEXT_LIMIT = 1_500;

/**
 * Whether `text` has more than `limit` characters that are not whitespace
 * (as `\s` matches it); its whitespace-collapsed form is then longer too.
 */
function moreVisibleTextThan(text: string, limit: number): boolean {
  if (text.length <= limit) return false;
  let visible = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    const space =
      (code >= 9 && code <= 13) ||
      code === 32 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff;
    if (!space && ++visible > limit) return true;
  }
  return false;
}

type BotCheckPage = Pick<
  ApplyFormObservation,
  "title" | "bodyTextExcerpt" | "headings"
> & {
  controls: readonly Pick<
    ApplyFormObservation["controls"][number],
    "kind" | "visible"
  >[];
  links: readonly Pick<ApplyFormObservation["links"][number], "visible">[];
};

const CHALLENGE_HEADING =
  /^(?:just a moment(?:\.{3}|…)?|verify (?:you are|you're|that you are) (?:a )?human[.!]?|checking your browser(?:\.{3}|…)?|security (?:check|verification)[.!]?)$/iu;
const CHALLENGE_TEXT =
  /^(?:verify (?:you are|you're|that you are) (?:a )?human|checking your browser|performing security verification|verifying (?:you are human|your browser)|checking if the site connection is secure|enable javascript and cookies to continue)\b/iu;

/** A challenge must replace the page, rather than merely be mentioned on it. */
export function isBotCheckInterstitial(
  observation: BotCheckPage,
  hasChallengeElement = false,
): boolean {
  const text = observation.bodyTextExcerpt.replace(/\s+/gu, " ").trim();
  const sparse =
    text.length <= CHALLENGE_TEXT_LIMIT &&
    observation.links.filter((link) => link.visible).length <= 5 &&
    !observation.controls.some(
      (control) =>
        control.visible &&
        !["checkbox", "radio", "other"].includes(control.kind),
    );
  if (!sparse) return false;

  const challengeHeading = [
    observation.title ?? "",
    ...observation.headings.map((heading) => heading.text),
  ].some((heading) => CHALLENGE_HEADING.test(heading.trim()));
  return (
    challengeHeading ||
    CHALLENGE_TEXT.test(text) ||
    (hasChallengeElement &&
      (text.length === 0 ||
        /^(?:please (?:complete|solve) (?:the|this) (?:security )?(?:check|challenge)|i'?m not a robot|are you a robot)\b/iu.test(
          text,
        )))
  );
}

/** Structure is read only; no challenge is clicked or solved. */
export async function inspectBotCheckInterstitial(
  observation: BotCheckPage,
  page?: Page,
): Promise<boolean> {
  if (isBotCheckInterstitial(observation)) return true;
  if (!page) return false;
  const hasChallengeElement = await page
    .evaluate(() =>
      Boolean(
        document.querySelector(
          '#challenge-form, [id^="cf-chl"], form[action*="challenge"], iframe[src*="challenge-platform"], iframe[src*="captcha"], iframe[src*="turnstile"], script[src*="challenge-platform"]',
        ),
      ),
    )
    .catch(() => false);
  return isBotCheckInterstitial(observation, hasChallengeElement === true);
}

/** Ray ids and detail URLs can change on every retry; the source host cannot. */
export function createBotCheckTracker() {
  let previousHost: string | null = null;
  return (url: string | null, botCheck: boolean): string | null => {
    let host: string | null = null;
    try {
      host = url ? new URL(url).host : null;
    } catch {
      // An unreadable address cannot prove a repeated check on this source.
    }
    const repeated = botCheck && host !== null && previousHost === host;
    previousHost = botCheck ? host : null;
    return repeated
      ? `${host} is showing a bot check. Open it in the browser, get past the check, then search again.`
      : null;
  };
}
