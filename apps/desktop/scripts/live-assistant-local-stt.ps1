param(
  [Parameter(Mandatory = $true)]
  [string]$Audio,

  [Parameter(Mandatory = $true)]
  [string]$Output,

  [string]$Language = "en-US",

  [string]$Source = "meeting_audio"
)

$ErrorActionPreference = "Stop"

function Resolve-CommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Candidate,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  if ([System.IO.Path]::IsPathRooted($Candidate)) {
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
      throw "$Name was not found at $Candidate."
    }

    return (Resolve-Path -LiteralPath $Candidate).Path
  }

  $resolved = Get-Command $Candidate -ErrorAction SilentlyContinue
  if (-not $resolved) {
    throw "$Name command '$Candidate' was not found on PATH."
  }

  return $resolved.Source
}

function Normalize-Language {
  param([string]$Value)

  if ($Value -match "^([a-zA-Z]{2})") {
    return $Matches[1].ToLowerInvariant()
  }

  return "auto"
}

$whisperCandidate = if ($env:NESTOR_INTERVIEW_WHISPER_CPP_EXE) {
  $env:NESTOR_INTERVIEW_WHISPER_CPP_EXE
} else {
  "whisper-cli"
}
$ffmpegCandidate = if ($env:NESTOR_FFMPEG_PATH) {
  $env:NESTOR_FFMPEG_PATH
} else {
  "ffmpeg"
}

if (-not $env:NESTOR_INTERVIEW_WHISPER_CPP_MODEL) {
  throw "NESTOR_INTERVIEW_WHISPER_CPP_MODEL must point to a local Whisper.cpp ggml model."
}

$whisper = Resolve-CommandPath -Candidate $whisperCandidate -Name "Whisper.cpp"
$ffmpeg = Resolve-CommandPath -Candidate $ffmpegCandidate -Name "FFmpeg"
$model = (Resolve-Path -LiteralPath $env:NESTOR_INTERVIEW_WHISPER_CPP_MODEL).Path
$inputAudio = (Resolve-Path -LiteralPath $Audio).Path
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "nestor-interview-stt-$([System.Guid]::NewGuid().ToString('N'))"

New-Item -ItemType Directory -Path $tempDir | Out-Null

try {
  $wavPath = Join-Path $tempDir "chunk.wav"
  $outputBase = Join-Path $tempDir "transcript"
  $outputTextPath = "$outputBase.txt"
  $whisperStdoutPath = Join-Path $tempDir "whisper.stdout.txt"
  $whisperStderrPath = Join-Path $tempDir "whisper.stderr.txt"
  $languageCode = Normalize-Language -Value $Language

  & $ffmpeg -hide_banner -loglevel error -y -i $inputAudio -ar 16000 -ac 1 -c:a pcm_s16le $wavPath
  if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg could not convert the $Source chunk for transcription."
  }

  $whisperProcess = Start-Process -FilePath $whisper -ArgumentList @(
    "-m", $model,
    "-f", $wavPath,
    "-l", $languageCode,
    "-otxt",
    "-of", $outputBase,
    "-nt",
    "-np",
    "-ng",
    "-t", "4"
  ) -NoNewWindow -Wait -PassThru -RedirectStandardOutput $whisperStdoutPath -RedirectStandardError $whisperStderrPath
  if ($whisperProcess.ExitCode -ne 0) {
    $stderr = (Get-Content -LiteralPath $whisperStderrPath -Raw -ErrorAction SilentlyContinue).Trim()
    throw "Whisper.cpp failed to transcribe the $Source chunk. $stderr"
  }

  if (-not (Test-Path -LiteralPath $outputTextPath -PathType Leaf)) {
    throw "Whisper.cpp did not write a transcript file."
  }

  $text = (Get-Content -LiteralPath $outputTextPath -Raw).Trim()
  if (-not $text) {
    exit 0
  }

  $payload = [ordered]@{
    text = $text
    language = $Language
    confidence = $null
  } | ConvertTo-Json -Compress

  Set-Content -LiteralPath $Output -Value $payload -NoNewline -Encoding UTF8
  Write-Output $payload
} finally {
  Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
