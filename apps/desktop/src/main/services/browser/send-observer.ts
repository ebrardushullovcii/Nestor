/**
 * Watches the person's own presses of a form's send in a tab, without
 * cancelling anything or giving page scripts any app command. Only trusted
 * input counts. On a page that is not a prepared application it reports a
 * press of a send-looking control (a recording hint); on a prepared one, any
 * form the person submits or send they press. The tokens go out as console
 * messages, which reach the main process even after the page moves on.
 */
export function sendObserverSource(
  unboundToken: string,
  boundToken: string,
): string {
  return `(() => {
        if (window.__nestorUnboundSendObserver) return;
        window.__nestorUnboundSendObserver = true;
        const isBound = () => window.__nestorPreparedApplication || sessionStorage.getItem('__nestorPreparedApplication');
        const finalControl = element => element && /(?:submit|send[-_\\s]*application|complete[-_\\s]*(?:the[-_\\s]*)?application|apply[-_\\s]*(?:now|job))/iu.test([element.textContent, element.getAttribute('aria-label'), element.value].filter(Boolean).join(' '));
        const submits = element => !!element && element.type === 'submit' && !!element.form;
        const note = (element, submitted) => {
          if (!isBound()) { if (finalControl(element)) console.debug(${JSON.stringify(unboundToken)}); return; }
          if (submitted || finalControl(element) || submits(element)) console.debug(${JSON.stringify(boundToken)});
        };
        document.addEventListener('submit', event => { if (event.isTrusted) note(event.submitter, true); }, true);
        document.addEventListener('click', event => { if (event.isTrusted) note(event.target?.closest('button,input[type=submit],[role=button]'), false); }, true);
      })()`;
}
