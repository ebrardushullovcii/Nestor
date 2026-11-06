export class ModelOutputLimitError extends Error {
  constructor(reason = "length") {
    super(`The AI service returned an incomplete response: ${reason}`);
    this.name = "ModelOutputLimitError";
  }
}

export function isModelOutputLimit(error: unknown): boolean {
  return (
    error instanceof ModelOutputLimitError ||
    (error instanceof Error &&
      /incomplete response:\s*(?:max_output_tokens|length)\b/iu.test(
        error.message,
      ))
  );
}
