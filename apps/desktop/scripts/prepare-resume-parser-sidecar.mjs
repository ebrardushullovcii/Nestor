import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const sourceScriptPath = path.join(
  desktopDir,
  "src",
  "main",
  "adapters",
  "scripts",
  "resume_parser_sidecar.py",
);
const outputRoot = path.join(desktopDir, "dist", "resume-parser-sidecar");
const buildRoot = path.join(outputRoot, "build");
const manifestPath = path.join(outputRoot, "manifest.json");
const bundledRequirements = [
  "pdfplumber",
  "pypdf",
  "python-docx",
  "pypdfium2",
  "Pillow",
  "pyinstaller",
];

function readCliOption(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function shouldFailHard() {
  const cliMode = readCliOption("--mode") ?? null;
  const envMode = process.env.NESTOR_RESUME_PARSER_PREPARE_MODE?.trim() ?? null;
  const mode = cliMode ?? envMode ?? "best-effort";

  return mode === "required";
}

function parseTargetMatrix() {
  const cliTarget =
    readCliOption("--target") ??
    process.env.NESTOR_RESUME_PARSER_TARGET ??
    null;

  if (!cliTarget || cliTarget === "current") {
    return [{ platform: process.platform, arch: process.arch }];
  }

  return cliTarget
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [platform, arch] = entry.split("-", 2);
      if (!platform || !arch) {
        throw new Error(
          `Invalid resume parser target "${entry}". Expected values like win32-x64 or darwin-arm64.`,
        );
      }

      return { platform, arch };
    });
}

function isHostTarget(target) {
  return target.platform === process.platform && target.arch === process.arch;
}

function getTargetBinaryName(platform) {
  return platform === "win32"
    ? "resume_parser_sidecar.exe"
    : "resume_parser_sidecar";
}

function getPythonRootForTarget(target) {
  return path.join(outputRoot, "python", `${target.platform}-${target.arch}`);
}

function getRuntimeSitePackagesForTarget(target) {
  return path.join(getPythonRootForTarget(target), "site-packages");
}

function getCopiedScriptPathForTarget(target) {
  return path.join(getPythonRootForTarget(target), "resume_parser_sidecar.py");
}

function getBinaryDirForTarget(target) {
  return path.join(outputRoot, "bin", `${target.platform}-${target.arch}`);
}

function getBinaryPathForTarget(target) {
  return path.join(
    getBinaryDirForTarget(target),
    getTargetBinaryName(target.platform),
  );
}

function getManifestPath(filePath) {
  return path.relative(outputRoot, filePath).split(path.sep).join("/");
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function buildPythonCandidates() {
  const override = process.env.NESTOR_RESUME_PARSER_PYTHON?.trim();

  if (override) {
    return [{ command: override, args: [], label: override }];
  }

  const commands =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"], label: "py -3" },
          { command: "python", args: [], label: "python" },
          { command: "python3", args: [], label: "python3" },
        ]
      : [
          { command: "python3", args: [], label: "python3" },
          { command: "python", args: [], label: "python" },
          { command: "py", args: ["-3"], label: "py -3" },
        ];

  return commands;
}

async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? desktopDir,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with code ${code ?? "unknown"}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

async function resolvePythonCandidate() {
  let lastError = null;

  for (const candidate of buildPythonCandidates()) {
    try {
      await runCommand(candidate.command, [...candidate.args, "--version"]);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }

  throw (
    lastError ??
    new Error(
      "No usable Python interpreter was found for resume parser sidecar packaging.",
    )
  );
}

async function readExistingManifest() {
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function computeBuildSignature() {
  const scriptSource = await readFile(sourceScriptPath, "utf8");
  return createHash("sha256")
    .update(scriptSource)
    .update(JSON.stringify(bundledRequirements))
    .update(process.platform)
    .update(process.arch)
    .digest("hex");
}

async function prepareSidecarBundleForTarget(target, signature) {
  const pythonRoot = getPythonRootForTarget(target);
  const runtimeSitePackages = getRuntimeSitePackagesForTarget(target);
  const copiedScriptPath = getCopiedScriptPathForTarget(target);
  const binaryDir = getBinaryDirForTarget(target);
  const binaryPath = getBinaryPathForTarget(target);
  const buildTargetRoot = path.join(
    buildRoot,
    `${target.platform}-${target.arch}`,
  );
  const existingManifest = await readExistingManifest();
  const existingTarget =
    existingManifest?.targets?.[`${target.platform}-${target.arch}`];

  if (
    existingManifest?.signature === signature &&
    existingTarget?.ready &&
    existsSync(copiedScriptPath) &&
    existsSync(binaryPath)
  ) {
    const portableTarget = {
      ...existingTarget,
      binaryPath: getManifestPath(binaryPath),
      pythonRoot: getManifestPath(pythonRoot),
    };
    if (JSON.stringify(portableTarget) !== JSON.stringify(existingTarget)) {
      await writeFile(
        manifestPath,
        JSON.stringify(
          {
            ...existingManifest,
            targets: {
              ...existingManifest.targets,
              [`${target.platform}-${target.arch}`]: portableTarget,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    }
    log(
      `Resume parser sidecar already prepared for ${target.platform}-${target.arch} at ${outputRoot}`,
    );
    return;
  }

  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `Cross-platform sidecar bundling must run on the target host platform. Requested ${target.platform}-${target.arch}, current host is ${process.platform}-${process.arch}.`,
    );
  }

  const pythonCandidate = await resolvePythonCandidate();

  await rm(pythonRoot, { recursive: true, force: true });
  await rm(binaryDir, { recursive: true, force: true });
  await rm(buildTargetRoot, { recursive: true, force: true });
  await mkdir(runtimeSitePackages, { recursive: true });
  await mkdir(binaryDir, { recursive: true });
  await mkdir(buildTargetRoot, { recursive: true });
  await copyFile(sourceScriptPath, copiedScriptPath);

  const pythonPath = [runtimeSitePackages, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(path.delimiter);
  const commandEnv = {
    ...process.env,
    PYTHONPATH: pythonPath,
  };

  log("Installing bundled Python PDF dependencies...");
  await runCommand(
    pythonCandidate.command,
    [
      ...pythonCandidate.args,
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--upgrade",
      "--target",
      runtimeSitePackages,
      ...bundledRequirements,
    ],
    { env: commandEnv },
  );

  log("Building standalone resume parser sidecar binary...");
  await runCommand(
    pythonCandidate.command,
    [
      ...pythonCandidate.args,
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onefile",
      "--name",
      "resume_parser_sidecar",
      "--distpath",
      binaryDir,
      "--workpath",
      path.join(buildTargetRoot, "work"),
      "--specpath",
      path.join(buildTargetRoot, "spec"),
      "--hidden-import",
      "pdfplumber",
      "--hidden-import",
      "pypdf",
      "--hidden-import",
      "docx",
      "--collect-all",
      "pdfplumber",
      "--collect-all",
      "pypdf",
      "--collect-all",
      "docx",
      "--collect-all",
      "pypdfium2",
      "--collect-all",
      "PIL",
      "--collect-all",
      "pdfminer",
      copiedScriptPath,
    ],
    { env: commandEnv },
  );

  const nextManifest = {
    generatedAt: new Date().toISOString(),
    signature,
    bundledRequirements,
    targets: {
      ...(existingManifest?.targets ?? {}),
      [`${target.platform}-${target.arch}`]: {
        ready: true,
        platform: target.platform,
        arch: target.arch,
        binaryPath: getManifestPath(binaryPath),
        pythonRoot: getManifestPath(pythonRoot),
        pythonCommand: pythonCandidate.label,
      },
    },
  };

  await writeFile(manifestPath, JSON.stringify(nextManifest, null, 2), "utf8");

  log(
    `Prepared resume parser sidecar bundle for ${target.platform}-${target.arch} at ${outputRoot}`,
  );
}

async function prepareSidecarBundle() {
  const signature = await computeBuildSignature();
  const targets = parseTargetMatrix();
  const hostTargets = targets.filter(isHostTarget);
  const skippedTargets = targets.filter((target) => !isHostTarget(target));

  await mkdir(outputRoot, { recursive: true });

  for (const target of skippedTargets) {
    log(
      `[ResumeImport] Skipping ${target.platform}-${target.arch}: native sidecar bundles must be built on the matching host platform (current host ${process.platform}-${process.arch}).`,
    );
  }

  if (hostTargets.length === 0) {
    throw new Error(
      `No requested resume parser targets match the current host (${process.platform}-${process.arch}). Run the prepare command on each target OS instead.`,
    );
  }

  for (const target of hostTargets) {
    await prepareSidecarBundleForTarget(target, signature);
  }
}

prepareSidecarBundle().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);

  if (shouldFailHard()) {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
    return;
  }

  process.stderr.write(
    `[ResumeImport] Skipping bundled sidecar preparation: ${message}\n`,
  );
  process.stderr.write(
    "[ResumeImport] Desktop app can still run, but resume import may fall back to embedded parsing until a bundled sidecar is prepared.\n",
  );
});
