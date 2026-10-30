import { personSubmissionObserverSource } from "@nestor/browser-runtime/apply-page";

/**
 * Watches the person's own presses of a form's send in a tab, without
 * cancelling anything or giving page scripts any app command. Only trusted
 * input counts. On a page that is not a prepared application it reports a
 * press of a send-looking control (a recording hint); on a prepared one, an
 * observed final application control. The tokens go out as console
 * messages, which reach the main process even after the page moves on.
 */
export function sendObserverSource(
  unboundToken: string,
  boundToken: string,
): string {
  return personSubmissionObserverSource({
    unbound: unboundToken,
    bound: boundToken,
  });
}
