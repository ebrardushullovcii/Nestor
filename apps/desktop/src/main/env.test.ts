import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  getDefaultDesktopEnvPaths,
  loadDesktopEnvironment,
  parseDotEnvContent,
} from "./setup/env";

describe("desktop env loader", () => {
  test("parses dotenv content with quotes and comments", () => {
    expect(
      parseDotEnvContent(
        [
          "# comment",
          "NORDRI_AI_API_KEY=abc123",
          'NORDRI_AI_MODEL="gpt-5.6-luna"',
          "export NORDRI_AI_BASE_URL='https://api.openai.com/v1'",
        ].join("\n"),
      ),
    ).toEqual({
      NORDRI_AI_API_KEY: "abc123",
      NORDRI_AI_MODEL: "gpt-5.6-luna",
      NORDRI_AI_BASE_URL: "https://api.openai.com/v1",
    });
  });

  test("loads values without overriding existing environment", () => {
    const env: NodeJS.ProcessEnv = {
      NORDRI_AI_MODEL: "existing-model",
    };

    loadDesktopEnvironment(
      env,
      ["virtual-a.env", "virtual-b.env"].map((entry) =>
        path.join("Z:/", entry),
      ),
    );

    expect(env.NORDRI_AI_MODEL).toBe("existing-model");
  });

  test("lists root and desktop env file locations", () => {
    const paths = getDefaultDesktopEnvPaths();

    expect(paths.some((entry) => entry.endsWith(path.join(".env")))).toBe(true);
    expect(paths.some((entry) => entry.endsWith(path.join(".env.local")))).toBe(
      true,
    );
  });
});

test("inline route comments are not passed to the model or API-mode parser", () => {
  expect(
    parseDotEnvContent(
      [
        "NORDRI_AI_AGGRESSIVE_MODEL=muse-spark-1.3-contributor # deepseek-v4.1-flash",
        "NORDRI_AI_AGGRESSIVE_API_MODE=responses # chat_completions",
        "NORDRI_AI_AGGRESSIVE_REASONING_EFFORT=xhigh # high",
      ].join("\n"),
    ),
  ).toEqual({
    NORDRI_AI_AGGRESSIVE_MODEL: "muse-spark-1.3-contributor",
    NORDRI_AI_AGGRESSIVE_API_MODE: "responses",
    NORDRI_AI_AGGRESSIVE_REASONING_EFFORT: "xhigh",
  });
});

test("quoted hashes stay in values and quotes in trailing comments stay out", () => {
  expect(
    parseDotEnvContent(
      [
        'HASH="value#kept" # comment "with quotes"',
        "SINGLE='value#kept' # comment 'with quotes'",
        "UNQUOTED=trimmed#comment",
        "EMPTY= #comment",
      ].join("\n"),
    ),
  ).toEqual({
    HASH: "value#kept",
    SINGLE: "value#kept",
    UNQUOTED: "trimmed",
    EMPTY: "",
  });
});
