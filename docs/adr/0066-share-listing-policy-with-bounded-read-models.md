# ADR 0066: Share listing policy with bounded read models

Status: accepted (2026-10-24).

The query list matched the legacy list's IDs and counts but differed in complete
ordering, activity and row facts. A screen cannot switch while those differ.

`packages/job-list-policy` holds the existing source-generic identity, activity
and ordering functions. Job Finder re-exports its previous entry points. The
database reader can use that policy without depending on the orchestration
package or introducing a dependency cycle. Browser-safe ordering and source
attribution have explicit subpath exports; Node identity code stays outside the
renderer. No matching, scoring or listing-closure rule changes.

The SQLite read index stores the actual provider date, reason inputs, source
attribution metadata and the same thin listing identity fields used by the
legacy activity index. Ledger observations have no body, so their identity index
does not need listing text. Exact identity ambiguity, activity timestamps and
tie priority use the existing policy. A connection-local TEMP table contains
only the resulting activity facts. A transactional revision changes only when
identity, sightings, closure evidence, inactive ledger observations or signals
change; a shortlist/hide status edit reuses the activity projection.

Node SQLite does not expose a custom collation callback. The reader ranks
distinct scalar strings with the existing default locale comparison and the
existing English numeric company collator. SQL uses those ranks to order its
bounded page. Equal collation keys remain equal; they do not acquire a new
binary tie-break. Newest uses the shared posting-date resolver, sinks explicit
skip recommendations and retains the canonical fit order for equal dates.

Page replies include source labels, activity, provider dates and the compact
inputs needed by the current reason line. No incomplete `SavedJob` is returned.
Recommendation, source-label, work-mode, activity and new-since filters stay
source-generic. Facet options/counts describe the requested list and result-band
pool before selected filters; location-reach counts describe the filtered pool.
The same pool supplies lookalike references, including rows on other pages.
Pending intake calls the existing utility policy with real metadata and reads
the pending body's value by ID only when that policy requests it. Curated rows
remain recoverable and complete all-job queries retain every row.

Canonical repository reads, exports, evidence and writes remain complete and
unchanged. The original UX comparison and extended field/filter comparison
pass on both owner-data copies in the built app: complete ordering for all six
sort/band combinations, activity, row facts and 31 filter cases. This establishes
list parity; it does not establish the separate startup and responsiveness budgets.
