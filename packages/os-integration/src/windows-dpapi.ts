import { spawn } from "node:child_process";
import path from "node:path";

// Electron safeStorage cannot unprotect another application's DPAPI blob.
// Windows PowerShell 5.1 supplies ProtectedData without a native addon. Only
// this fixed script is an argument; binary input/output travels over pipes.
const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputBytes = $null
$plain = $null
$memory = New-Object System.IO.MemoryStream
$code = 0
try {
  Add-Type -AssemblyName System.Security
  [Console]::OpenStandardInput().CopyTo($memory)
  $inputBytes = $memory.ToArray()
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  $output = [Console]::OpenStandardOutput()
  $output.Write($plain, 0, $plain.Length)
  $output.Flush()
} catch { $code = 1 } finally {
  if ($null -ne $plain) { [Array]::Clear($plain, 0, $plain.Length) }
  if ($null -ne $inputBytes) { [Array]::Clear($inputBytes, 0, $inputBytes.Length) }
  [Array]::Clear($memory.GetBuffer(), 0, $memory.Capacity)
  $memory.Dispose()
}
exit $code
`;

/** Main-process only. Caller owns and must clear the returned secret buffer. */
export function unprotectWindowsCurrentUserData(
  blob: Uint8Array,
): Promise<Buffer> {
  if (process.platform !== "win32" || !blob.length || blob.length > 64 * 1024)
    return Promise.reject(new Error("Windows key access is unavailable."));
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const input = Buffer.from(blob);
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (failed || size > 64 * 1024) {
        chunk.fill(0);
        stop();
      } else chunks.push(chunk);
    });
    child.stdin.on("error", stop);
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      input.fill(0);
      const output =
        !failed && code === 0 && size > 0 ? Buffer.concat(chunks) : null;
      for (const chunk of chunks) chunk.fill(0);
      // Never propagate native stderr, arguments, or secret-bearing errors.
      if (output) resolve(output);
      else reject(new Error("Windows key access failed."));
    });
    child.stdin.end(input);
  });
}
