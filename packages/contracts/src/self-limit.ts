import type { reportSelfLimitHit } from "@nestor/core";

/** Shared log record; the implementation stays in the dependency-free core. */
export type SelfLimitHit = Parameters<typeof reportSelfLimitHit>[0];
