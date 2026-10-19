// Windows has no ps, head or tail, and $.fs only reads whole files of at most 4 MiB. So one
// PowerShell process per scan answers both questions: which pids are running (and since when),
// and what the ends of the transcripts that changed say.
import { HEAD_BYTES, START_TOLERANCE, TAIL_BYTES, TOKENS_MAX_BYTES, TOKENS_WINDOW_BYTES } from './constants.ts'

export type HelperFile = { path: string; mode: 'tokens' | 'ends' }
export type HelperRequest = { pids: number[]; files: HelperFile[] }
export type HelperProcess = { pid: number; name: string; start: string }
// `lines` (tokens): the last main-thread reply that carries usage. `head`/`tail` (ends): raw text,
// cut mid-line at the edges. `error`: why the file couldn't be read.
export type HelperRead = { path: string; size: number; lines: string[]; head: string; tail: string; error: string | null }
export type HelperReply = { procs: HelperProcess[]; files: HelperRead[] }

// Written one statement per line for reading; HELPER_SCRIPT below is what runs.
// No double quotes ([char]34 stands in) and no backticks, so it passes through Windows command-line
// quoting unchanged, and every `}` that a catch, finally or else follows shares its line.
const HELPER_SOURCE = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$q = [string][char]34
$nl = [char]10
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$procs = @()
$ids = @($req.pids | Where-Object { $_ })
if ($ids.Count -gt 0) {
  foreach ($p in @(Get-Process -Id $ids -ErrorAction SilentlyContinue)) {
    $start = ''
    try { $start = [string]$p.StartTime.ToFileTimeUtc() } catch {}
    $procs += [pscustomobject]@{ pid = $p.Id; name = $p.ProcessName; start = $start }
  }
}
function Read-Bytes($fs, [long]$from, [long]$count) {
  if ($count -le 0) { return '' }
  $buf = New-Object byte[] $count
  $fs.Position = $from
  $got = 0
  while ($got -lt $count) {
    $n = $fs.Read($buf, $got, $count - $got)
    if ($n -le 0) { break }
    $got += $n
  }
  [System.Text.Encoding]::UTF8.GetString($buf, 0, $got)
}
$usage = $q + 'usage' + $q
$assistant = $q + 'assistant' + $q
$side = $q + 'isSidechain' + $q + ':true'
$files = @()
foreach ($f in @($req.files)) {
  $out = [ordered]@{ path = $f.path; size = 0; lines = @(); head = ''; tail = ''; error = $null }
  try {
    $fs = [System.IO.File]::Open($f.path, 'Open', 'Read', 'ReadWrite, Delete')
    try {
      $len = $fs.Length
      $out.size = $len
      if ($f.mode -eq 'ends') {
        $out.head = Read-Bytes $fs 0 ([Math]::Min($len, ${HEAD_BYTES}))
        $from = [Math]::Max(0, $len - ${TAIL_BYTES})
        $out.tail = Read-Bytes $fs $from ($len - $from)
      } else {
        $found = @()
        for ($w = ${TOKENS_WINDOW_BYTES}; $found.Count -eq 0; $w *= 4) {
          $from = [Math]::Max(0, $len - $w)
          $lines = (Read-Bytes $fs $from ($len - $from)).Split($nl)
          $first = 0
          if ($from -gt 0) { $first = 1 }
          for ($i = $lines.Length - 1; $i -ge $first; $i--) {
            $l = $lines[$i]
            if ($l.Contains($usage) -and $l.Contains($assistant) -and -not $l.Contains($side)) { $found = @($l); break }
          }
          if ($from -eq 0 -or $w -ge ${TOKENS_MAX_BYTES}) { break }
        }
        $out.lines = @($found)
      }
    } finally { $fs.Dispose() }
  } catch { $out.error = $_.Exception.Message }
  $files += [pscustomobject]$out
}
[pscustomobject]@{ procs = @($procs); files = @($files) } | ConvertTo-Json -Depth 4 -Compress
`

// A multi-line -Command runs nothing when Claude Code starts PowerShell (it exits 0, silent),
// so the script goes as one line. Execution policy doesn't apply to -Command.
export const HELPER_SCRIPT = HELPER_SOURCE.split('\n').map(line => line.trim()).filter(Boolean).join('; ')

// pwsh first; Windows PowerShell 5.1 ships with every Windows and is the fallback.
export const POWERSHELLS = ['pwsh', 'powershell'] as const

export const helperArgv = (exe: string) => [exe, '-NoProfile', '-NonInteractive', '-Command', HELPER_SCRIPT]

// ConvertTo-Json writes a one-element array as itself on some versions, and null for an empty one.
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : x == null ? [] : [x])

export const parseHelperReply = (stdout: string): HelperReply => {
  const raw = JSON.parse(stdout.trim().replace(/^﻿/, '')) ?? {}
  return {
    procs: list(raw.procs).map((p: any) => ({ pid: Number(p?.pid), name: String(p?.name ?? ''), start: String(p?.start ?? '') })),
    files: list(raw.files).map((f: any) => ({
      path: String(f?.path ?? ''),
      size: Number(f?.size ?? 0),
      lines: list(f?.lines).map(String),
      head: String(f?.head ?? ''),
      tail: String(f?.tail ?? ''),
      error: f?.error == null ? null : String(f.error),
    })),
  }
}

// A pid can be reused once its session has ended. The registry records when the session's process
// started (a Windows FILETIME), so a running process with that pid and that start time is the session.
// Older registry files without it fall back to the process name.
export const isSessionProcess = (procStart: string | null, proc: HelperProcess) => {
  const a = Number(procStart)
  const b = Number(proc.start)
  if (procStart && proc.start && Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < START_TOLERANCE
  return /^(claude|node|bun)$/i.test(proc.name)
}
