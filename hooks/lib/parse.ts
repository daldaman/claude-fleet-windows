// Parsers for what fleet reads from disk and from commands: the session registry, git, and transcripts.
import type { Git, Registered, Row } from '../../types'

import { PROJECTS_DIR } from './constants.ts'

// --- Registry ---

// Reads only these fields of a registry file; the others hold tokens and sockets and are never touched.
export const parseRegistryEntry = (text: string, mtimeMs: number): Registered | null => {
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  if (typeof raw.pid !== 'number' || typeof raw.cwd !== 'string') return null
  return {
    pid: raw.pid,
    procStart: typeof raw.procStart === 'string' && /^\d+$/.test(raw.procStart) ? raw.procStart : null,
    name: String(raw.name ?? raw.sessionId ?? raw.pid),
    // 'derived' names are Claude Code's own (folder + suffix); anything else the person set.
    isNamed: typeof raw.nameSource === 'string' && raw.nameSource !== 'derived',
    status: String(raw.status ?? 'unknown'),
    waitingFor: typeof raw.waitingFor === 'string' && raw.waitingFor ? raw.waitingFor : null,
    cwd: raw.cwd,
    sessionId: String(raw.sessionId ?? ''),
    updatedAt: Number(raw.updatedAt ?? mtimeMs),
  }
}

// --- Paths ---

// One spelling per folder, for comparing: registry cwds use backslashes, git answers with forward ones,
// and Windows paths ignore case.
export const samePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// --- Git ---

// `git status --porcelain=v2 --branch` → branch, uncommitted files, ahead/behind.
export const parseGitStatus = (stdout: string): Git => {
  const git: Git = { branch: '?', dirty: 0, ahead: 0, behind: 0, hasUpstream: false }
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) git.branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.ab ')) {
      const [, a, b] = line.match(/\+(\d+) -(\d+)/) ?? []
      git.ahead = Number(a ?? 0)
      git.behind = Number(b ?? 0)
      git.hasUpstream = true
    } else if (line && !line.startsWith('#')) git.dirty += 1
  }
  return git
}

// `git worktree list --porcelain` → worktree paths.
export const parseWorktrees = (stdout: string) =>
  stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))

// --- Transcripts ---

// Claude Code's project folder name: every character outside [A-Za-z0-9] becomes '-',
// so C:\Users\me\code is C--Users-me-code.
export const transcriptPath = (configDir: string, row: Pick<Row, 'cwd' | 'sessionId'>) =>
  `${configDir}/${PROJECTS_DIR}/${row.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${row.sessionId}.jsonl`

// Context size of the last main-thread reply; what resuming re-sends.
export const lastContextTokens = (tail: string): number | null => {
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const u = entry.message?.usage
      if (!u) continue
      return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    } catch {
      // The first line of a tail is usually cut mid-entry.
    }
  }
  return null
}

export const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter(b => b?.type === 'text').map(b => String(b.text)).join('\n')
      : ''

// A user turn as the person typed it: reminders dropped, slash commands shown as typed.
export const cleanUserText = (text: string) =>
  text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-name>(.*?)<\/command-name>/g, '$1')
    .replace(/<command-args>(.*?)<\/command-args>/g, ' $1')
    .replace(/<\/?local-command-stdout>/g, '')
    .trim()

export const userPrompts = (jsonl: string) => {
  const prompts: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"user"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user' || entry.isSidechain || entry.isMeta) continue
      const text = cleanUserText(textOf(entry.message?.content))
      if (text) prompts.push(text.slice(0, 600))
    } catch {
      // A head or tail cut mid-entry.
    }
  }
  return prompts
}

export const lastAssistantText = (jsonl: string) => {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"assistant"')) continue
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'assistant' || entry.isSidechain) continue
      const text = textOf(entry.message?.content).trim()
      if (text) return text
    } catch {
      // Cut mid-entry.
    }
  }
  return ''
}
