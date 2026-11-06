/**
 * Snapshot the open page without changing it. A listing can live in a visible
 * same-origin frame; outerHTML alone contains only that frame's empty shell.
 * Cross-origin frames stay untouched, as do hidden tracking frames.
 */
export const BROWSER_JOB_PAGE_HTML = `(() => {
  let remaining = 12;
  const snapshot = (source, depth) => {
    // An inert document avoids running custom-element constructors while copying.
    const inert = source.implementation.createHTMLDocument('');
    const copy = inert.importNode(source.documentElement, true);
    // Each frame has its own base URL. Keep its links correct after inlining.
    for (const link of copy.querySelectorAll('a[href]')) {
      try { link.setAttribute('href', new URL(link.getAttribute('href'), source.baseURI).href); }
      catch {}
    }
    if (depth >= 4) return copy;
    const originals = source.querySelectorAll('iframe, frame');
    const copies = copy.querySelectorAll('iframe, frame');
    for (let index = 0; index < originals.length && remaining > 0; index++) {
      const frame = originals[index];
      try {
        const rect = frame.getBoundingClientRect();
        const style = source.defaultView.getComputedStyle(frame);
        if (rect.width <= 1 || rect.height <= 1 || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse') continue;
        const child = frame.contentDocument;
        if (!child?.body || !child.documentElement) continue;
        remaining--;
        const embedded = snapshot(child, depth + 1);
        const content = embedded.querySelector('body, frameset');
        if (!content) continue;
        const section = inert.createElement('section');
        section.append(...content.childNodes);
        copies[index].replaceWith(section);
      } catch {
        // Inaccessible or navigating frames do not hide the rest of the page.
      }
    }
    return copy;
  };
  return snapshot(document, 0).outerHTML;
})()`;
