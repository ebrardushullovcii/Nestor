# ADR 0070: Read original rows while startup conversion runs

Status: superseded: ADR 0074 removes the original-row fallback; job-store opening replaces the remaining canonical-writer and evidence-conversion gates (145ad266).

The original-row read fallback below is superseded by ADR 0074. Earlier writer
readiness and the evidence-conversion rules remain accepted.

An update can start with no scalar index. Waiting for its rebuild made counts
and the first page wait several seconds, even though original rows were readable.

The read-only connection derives temporary scalar rows from the index builder's
own SQL until a compatible committed index is available. The existing intake and
display policy supplies metadata for unconverted rows. Ordering, filters, page
counts and row DTOs use the same query path. A first page must match the selected
sort exactly; startup never substitutes another order. These reads can still
scan old JSON to rank a page, so independent latency measurements are required.
The temporary rows disappear when the stored index commits; they store no
canonical data. Each population reads one committed transaction and refreshes
after outside writes. Header, detail and change-feed reads never populate them.

The startup worker releases screen reads after additive schema preparation.
It separately releases the canonical writer after required schema and small
state migrations. Evidence conversion continues in the existing committed slices.
Typed repository reads and writes support both representations. Actions arriving
before writer readiness await that promise through the existing command path.
Corruption and restored-snapshot validation retain their canonical recovery path.

This supersedes ADRs 0065 and 0069's requirement that the canonical writer await
all evidence conversion. It preserves their backup, round-trip and restart rules,
and ADR 0067's private preload read connection. Legacy full-sync arrays remain
until their renderer consumers migrate; query readiness does not authorize their
removal.
