import { spawn } from "node:child_process";
import path from "node:path";

/** Reuse #384's pinned mock. Its child is always owned by this runner. */
export async function startProvider(
  root: string,
  output: string,
  label: string,
) {
  const child = spawn(
    process.execPath,
    [
      path.join(root, "apps/desktop/test-fixtures/google-mock/serve.mjs"),
      label,
      path.join(output, "google-provider"),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    const config = await new Promise<{
      configPath: string;
      employerOrigin: string;
    }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => reject(Error("Google fixture startup timed out")),
        15000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error(`Google fixture exited ${code}`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        if (!buffer.includes("\n")) return;
        clearTimeout(timer);
        try {
          resolve(
            JSON.parse(buffer.split("\n")[0]) as {
              configPath: string;
              employerOrigin: string;
            },
          );
        } catch (error) {
          reject(error instanceof Error ? error : Error(String(error)));
        }
      });
    });
    return {
      ...config,
      stop: () => {
        child.kill("SIGTERM");
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}
