import { z } from "zod";
import { fitLocationKinds } from "./fit-work-location";

const roleStates = [
  "strong",
  "related",
  "stretch",
  "unrelated",
  "unknown",
] as const;
const preferenceStates = ["aligned", "mixed", "conflict", "unknown"] as const;
const coverageStates = ["strong", "partial", "unknown"] as const;
const hardStates = ["met", "conflict", "unknown", "not_requested"] as const;
const eligibilityStates = ["compatible", "review", "blocked"] as const;
const intervals = ["hour", "day", "week", "month", "year"] as const;
const payBases = ["base", "total_ote"] as const;

// Objects let the response schema enforce each enum in its actual position.
// Read older tuple replies too; stored recordings and scripted clients use them.
function judgment<T extends readonly [string, ...string[]]>(states: T) {
  return z.union([
    z
      .object({ status: z.enum(states), reason: z.string() })
      .transform(
        ({ status, reason }) => [status, reason] as [T[number], string],
      ),
    z.tuple([z.enum(states), z.string()]),
  ]);
}

export const fitSchema = z.object({
  id: z.number().int().positive(),
  s: z.number().int().min(0).max(100),
  why: z.string(),
  w: z.string().default(""),
  r: judgment(roleStates),
  p: judgment(preferenceStates),
  c: judgment(coverageStates),
  h: judgment(hardStates).optional(),
  pay: z
    .object({
      minimum: z.number().nonnegative().nullable(),
      maximum: z.number().nonnegative().nullable(),
      currency: z.string().nullable(),
      interval: z.enum(intervals).nullable(),
      basis: z.enum(payBases).nullable(),
      quote: z.string(),
    })
    .optional(),
  e: z
    .union([
      z
        .object({
          status: z.enum(eligibilityStates),
          quote: z.string(),
          kind: z.enum(fitLocationKinds),
          countries: z.string(),
        })
        .transform(
          ({
            status,
            quote,
            kind,
            countries,
          }): [typeof status, string, typeof kind, string] => [
            status,
            quote,
            kind,
            countries,
          ],
        ),
      z.tuple([
        z.enum(eligibilityStates),
        z.string(),
        z.enum(fitLocationKinds),
        z.string(),
      ]),
    ])
    .default([
      "review",
      "Your work location or permission needs checking.",
      "unknown",
      "",
    ]),
});

const string = { type: "string" };
const enumeration = (values: readonly string[]) => ({
  type: "string",
  enum: [...values],
});
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const judgmentSchema = (states: readonly string[]) =>
  object({ status: enumeration(states), reason: string });
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});

/** The same enums and number bounds as the validator, with no batch-specific ids. */
export function fitResponseSchema() {
  return {
    name: "job_fits",
    schema: object({
      fits: {
        type: "array",
        items: object({
          id: { type: "integer", minimum: 1 },
          e: object({
            status: enumeration(eligibilityStates),
            quote: string,
            kind: enumeration(fitLocationKinds),
            countries: string,
          }),
          s: { type: "integer", minimum: 0, maximum: 100 },
          why: string,
          w: string,
          r: judgmentSchema(roleStates),
          p: judgmentSchema(preferenceStates),
          c: judgmentSchema(coverageStates),
          h: judgmentSchema(hardStates),
          pay: object({
            minimum: nullable({ type: "number", minimum: 0 }),
            maximum: nullable({ type: "number", minimum: 0 }),
            currency: nullable(string),
            interval: nullable(enumeration(intervals)),
            basis: nullable(enumeration(payBases)),
            quote: string,
          }),
        }),
      },
    }),
  };
}
