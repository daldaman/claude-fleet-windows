export type Git = { branch: string; dirty: number; ahead: number; behind: number; hasUpstream: boolean }

// Whether a session is worth re-caching: unfinished work (active), finished but substantial
// (reference: write a handoff and close it), or quick questions (light: just close it).
export type ResumeValue = 'active' | 'reference' | 'light'

export type Row = {
  key: string
  // Claude Code's name for the session; `isNamed` when the person chose it (then it beats `title`).
  name: string
  isNamed: boolean
  // A short topic written by Haiku from the conversation, once fleet has made one.
  title: string | null
  value: ResumeValue | null
  status: string
  // What a waiting session waits on, as Claude Code words it ("permission prompt").
  waitingFor: string | null
  cwd: string
  pid: number | null
  sessionId: string
  updatedAt: number
  isSelf: boolean
  git: Git | null
  // Context size of the session's last reply: what resuming it re-caches once the cache is cold.
  tokens: number | null
}

export type Snapshot = {
  rows: Row[]
  scannedAt: number
  // Why the list may be wrong or empty (the registry moved or changed format), else null.
  warning: string | null
}

// One session as Claude Code's registry describes it (only the fields fleet reads).
export type Registered = {
  pid: number
  // When that process started, as a Windows FILETIME string; tells a live session from a reused pid.
  procStart: string | null
  name: string
  isNamed: boolean
  status: string
  waitingFor: string | null
  cwd: string
  sessionId: string
  updatedAt: number
}

// A generated title and resume value, cached per session with the transcript size it was made at.
export type TitleEntry = { title: string; size: number; value?: ResumeValue }

declare module 'claude-code' {
  interface PluginState {
    fleet: {
      snapshot: Snapshot | null
      isOpen: boolean
      // The row the pane's actions apply to, by Row.key.
      selected: string | null
    }
  }
}
