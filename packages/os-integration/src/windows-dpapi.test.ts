import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { unprotectWindowsCurrentUserData } from "./windows-dpapi";

test.skipIf(process.platform !== "win32")(
  "DPAPI round-trips only a self-protected synthetic blob over binary pipes",
  async () => {
    const synthetic = Buffer.alloc(32, 0x57);
    const script = `
    Add-Type -AssemblyName System.Security
    $memory = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($memory)
    $plain = $memory.ToArray()
    $protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::OpenStandardOutput().Write($protected, 0, $protected.Length)
    [Array]::Clear($plain, 0, $plain.Length)
    [Array]::Clear($memory.GetBuffer(), 0, $memory.Capacity)
    $memory.Dispose()
  `;
    const protectedResult = spawnSync(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        input: synthetic,
        windowsHide: true,
        timeout: 15_000,
      },
    );
    expect(protectedResult.status === 0).toBe(true);
    const plain = await unprotectWindowsCurrentUserData(protectedResult.stdout);
    try {
      expect(plain.equals(synthetic)).toBe(true);
    } finally {
      plain.fill(0);
      synthetic.fill(0);
      protectedResult.stdout.fill(0);
    }
    await expect(
      unprotectWindowsCurrentUserData(Buffer.from("synthetic-invalid-blob")),
    ).rejects.toThrow("Windows key access failed.");
  },
  30_000,
);
