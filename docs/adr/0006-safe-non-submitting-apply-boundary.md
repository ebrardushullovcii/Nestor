# Safe Non-Submitting Apply Boundary

Status: superseded by [ADR 0012](0012-user-scoped-autonomous-application-authority.md).

Job Finder apply automation may assist with preparation, form context, recovery, resume approval checks, and reviewable application records, but it must stop before final submission unless the user explicitly re-authorizes live submit work in a new decision. This preserves user consent, avoids accidental applications, and keeps apply automation auditable while still letting the product provide useful non-submitting assistance.

## Considered Options

- Enable live submit by default: rejected because accidental or unreviewed applications are too high risk for the current product boundary.
- Treat visual evidence as apply authority: rejected because screenshots are evidence for review/recovery, not permission to act or submit.

## Consequences

- Apply code must preserve consent interrupts and resume approval gates.
- During unauthorized preparation the browser guard blocks every mutating request, every form submission and every channel (WebSocket, EventSource, beacons). Page-owned reads are allowed by shape (a GET, HEAD or OPTIONS request, or a POST whose body is a GraphQL document made only of queries) and refused the moment they would carry a value that is currently in a form field, since that is the only way a read could send a prepared answer. That lets a page load its form definition, language files, module manifest or GraphQL data and render at all; images and media with a query string remain blocked because the page guard cannot see what they carry.
- On a page with no application form, the runtime follows an Apply _link_ or a manual-entry _link_ ("Apply manually", "Start application") by opening its URL: that is the navigation it would make for an application URL anyway, and nothing on such a page is prepared. A manual-entry _button_ may be clicked; an Apply _button_ on a listing is never clicked, because with a signed-in profile it can be a one-click apply. A page the runtime just opened gets the same render grace as the first step before it is judged.
- Visual checkpoints must not produce browser actions, final-submit guidance, generated answers, selectors, or site-specific workflow rules.
- Reopening live submit requires an explicit new authorization and updated contracts, product docs, tests, and review flows.
