# ADR 0074: Build one index before inventory reads

Status: superseded: job-store columns and indexes are opened directly, without a separate scalar-index build or header/inventory readiness gates; legacy startup preparation was removed (145ad266).

The ADR 0070 fallback derived temporary scalar rows while a worker built the
same facts into the stored index. A quiet 12k diagnostic took 2,249 ms for the
temporary facts/counts and another 911 ms for the first Best match page; building
the stored index took 3,125 ms. In the built app, counts arrived after index
readiness on both copies: 3,877 versus 3,340 ms on 6k, and 3,655 versus 3,558 ms
on 12k. These are single samples, not startup acceptance.

Keep one stored scalar index. Release inventory queries after it commits; retain
the separate early header gate. Remove the temporary scalar fallback, its schema
switching and source-dependent cache generations. Preserve the selected sort and
existing list facts. Optimize the one index SELECT instead of building its facts
twice. A clean start reuses the index without scanning job bodies.

This supersedes only ADR 0070's original-row fallback and early inventory gate.
Its earlier canonical writer gate remains: typed actions need not await evidence
conversion, which still commits complete old/new rows in restartable slices.
Legacy renderer migration, full-sync removal and the subsecond launch budget
remain separate unfinished work.
