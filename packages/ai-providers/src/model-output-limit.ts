/**
 * Published output limits for the product's configured routes, including
 * reasoning tokens. Keep these in one place rather than budgeting each task.
 * Source: https://models.opencode.ai/providers/opencode-go/ (2026-11-06).
 * Unknown routes omit the field and let the provider choose its allowance.
 */
const MODEL_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  "deepseek-v4.1-flash": 384_000,
  "deepseek-v4-flash": 384_000,
  "deepseek-v4-pro": 384_000,
  "muse-spark-1.3-contributor": 131_072,
  "muse-spark-1.2-contributor": 131_072,
  "gpt-5.6-luna": 128_000,
  "gpt-6-luna": 128_000,
};

export function modelOutputLimit(model: string): number | undefined {
  return MODEL_OUTPUT_LIMITS[model];
}
