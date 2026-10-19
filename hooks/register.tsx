// Everything here touches `$`, which the engine only follows within this one file.
// Pure logic lives in ./lib: rules, formatting, parsing, the PowerShell helper, prompts, demo data and the view.
// A Windows port of Dubbus/claude-fleet (MIT), read-only for now: it shows sessions and never closes them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Git, Registered, Row, Snapshot, TitleEntry } from '../types'

import {
  ALIVE_TTL_MS, MISSING_RETRY_MS, PROJECTS_DIR, REGISTRY_DIR, STATUS_EVERY_TICKS, TICK_MS, TITLES_KEY, TITLES_PER_SCAN,
} from './lib/constants.ts'
import { demoRows } from './lib/demo.ts'
import { ago, asTable, HELP, label, needText, resumeCommand, staleReport, statusLineText } from './lib/format.ts'
import { helperArgv, isSessionProcess, parseHelperReply, POWERSHELLS } from './lib/helper.ts'
import type { HelperFile, HelperReply, HelperRequest } from './lib/helper.ts'
import {
  lastAssistantText, lastContextTokens, parseGitStatus, parseRegistryEntry, parseWorktrees, samePath, transcriptPath,
  userPrompts,
} from './lib/parse.ts'
import { LABEL_SYSTEM, labelPrompt, parseLabel } from './lib/prompts.ts'
import { isBusy, isDemo, needsYou, sortRows } from './lib/rules.ts'
import { paneView } from './lib/views.tsx'

// Kept here as a literal: hook matchers are read from this file, so an imported id would be opaque.
const PANE = 'fleet'

const snapshot = atom({ plugin: 'fleet', key: 'snapshot' } as const, null)
const isOpen = atom({ plugin: 'fleet', key: 'isOpen' } as const, false)
const selected = atom({ plugin: 'fleet', key: 'selected' } as const, null)

// Module state: lost on a reload, which only means asking or caching again.
// path -> { size, tokens }: a transcript is re-read only when it has grown.
const tokenCache = new Map<string, { size: number; tokens: number | null }>()
const transcriptCache = new Map<string, { path: string | null; at: number }>()
// In flight across scans, so a slow title call isn't started twice.
const titling = new Set<string>()
// Which registry entries were still running at the last check, by `pid:procStart`.
let alive: { at: number; keys: Set<string>; checked: Set<string> } = { at: 0, keys: new Set(), checked: new Set() }
// The PowerShell that started last time, so a missing pwsh is tried only once.
let powershell: string | null = null

const entryKey = (s: Registered) => `${s.pid}:${s.procStart ?? ''}`

// --- Where things are ---

// Windows sets USERPROFILE; HOME is there only when something like Git Bash set it.
async function configDir($: EngineInterface) {
  const custom = await $.env.get('CLAUDE_CONFIG_DIR')
  if (custom) return custom.replace(/[\\/]+$/, '')
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude` : null
}

// --- The PowerShell helper ---

async function runHelper($: EngineInterface, request: HelperRequest): Promise<HelperReply> {
  const stdin = JSON.stringify(request)
  let lastError = 'no PowerShell found'
  for (const exe of powershell ? [powershell] : POWERSHELLS) {
    let r
    try {
      r = await $.process.run(helperArgv(exe), { stdin, timeoutMs: 20_000 })
    } catch (err) {
      // Not installed (or timed out): try the next one.
      lastError = `${exe}: ${(err as Error).message}`
      continue
    }
    powershell = exe
    const why = r.stderr.trim().split('\n')[0]
    if (r.exitCode !== 0) throw new Error(`${exe} exited ${r.exitCode}: ${why || 'no message'}`)
    if (!r.stdout.trim()) throw new Error(`${exe} printed nothing${why ? `: ${why}` : ''}`)
    return parseHelperReply(r.stdout)
  }
  powershell = null
  throw new Error(lastError)
}

// --- Reading sessions ---

// The registry is internal to Claude Code, so a release can move or reshape it.
// Every way it can fail says why, rather than showing an empty fleet.
async function readRegistry($: EngineInterface): Promise<{ sessions: Registered[]; problem: string | null }> {
  // CLAUDE_FLEET_REGISTRY points fleet at another registry folder (a moved one, or a test fixture).
  const override = await $.env.get('CLAUDE_FLEET_REGISTRY')
  const config = await configDir($)
  if (!override && !config) return { sessions: [], problem: "Neither USERPROFILE nor HOME is set, so fleet can't find ~/.claude/sessions." }
  const dir = override || `${config}/${REGISTRY_DIR}`
  const shown = override || `~/.claude/${REGISTRY_DIR}`
  if (!(await $.fs.exists(dir))) {
    return { sessions: [], problem: `No ${shown} folder: this Claude Code version may keep its session list elsewhere.` }
  }

  const found: Registered[] = []
  let files = 0
  for (const entry of await $.fs.list(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    files += 1
    try {
      const parsed = parseRegistryEntry(String(await $.fs.read(`${dir}/${entry.name}`)), entry.mtimeMs)
      if (parsed) found.push(parsed)
    } catch {
      // A file mid-write or from another version: skip it this tick.
    }
  }
  if (files === 0) return { sessions: [], problem: `${shown} is empty, though this session is running: the registry may have moved.` }
  if (found.length === 0) {
    return { sessions: [], problem: `Couldn't read any of the ${files} files in ${shown}: their format may have changed.` }
  }
  return { sessions: found, problem: null }
}

// Registry files outlive crashed processes; keep only the sessions whose process is still the one that wrote them.
function keepAlive(sessions: Registered[], reply: HelperReply) {
  const byPid = new Map(reply.procs.map(p => [p.pid, p]))
  return new Set(sessions.filter(s => {
    const proc = byPid.get(s.pid)
    return proc !== undefined && isSessionProcess(s.procStart, proc)
  }).map(entryKey))
}

async function gitStatus($: EngineInterface, cwd: string): Promise<Git | null> {
  const r = await $.process.run(['git', '-C', cwd, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5000 }).catch(() => null)
  return r && r.exitCode === 0 ? parseGitStatus(r.stdout) : null
}

// Worktrees of this session's repo that no session is sitting in.
async function idleWorktrees($: EngineInterface, taken: Set<string>): Promise<string[]> {
  const r = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { cwd: await $.session.cwd(), timeoutMs: 5000 }).catch(() => null)
  return r && r.exitCode === 0 ? parseWorktrees(r.stdout).filter(path => !taken.has(samePath(path))) : []
}

// Transcripts are filed under the folder a session started in, which can differ from where it is
// now, so fall back to looking for the session's file in every project folder.
async function findTranscript($: EngineInterface, config: string, row: Pick<Row, 'cwd' | 'sessionId'>) {
  if (!row.sessionId) return null
  const direct = transcriptPath(config, row)
  if (await $.fs.exists(direct)) return direct

  const now = await $.clock.now()
  const hit = transcriptCache.get(row.sessionId)
  if (hit && (hit.path ? await $.fs.exists(hit.path) : now - hit.at < MISSING_RETRY_MS)) return hit.path

  let found: string | null = null
  for (const entry of await $.fs.list(`${config}/${PROJECTS_DIR}`)) {
    if (entry.kind !== 'dir') continue
    const path = `${config}/${PROJECTS_DIR}/${entry.name}/${row.sessionId}.jsonl`
    if (await $.fs.exists(path)) {
      found = path
      break
    }
  }
  transcriptCache.set(row.sessionId, { path: found, at: now })
  return found
}

async function scan($: EngineInterface, isFull: boolean): Promise<Snapshot> {
  if (await $.env.get('CLAUDE_FLEET_DEMO')) {
    const now = await $.clock.now()
    const demo: Snapshot = { rows: demoRows(now), scannedAt: now, warning: null }
    await update($, snapshot, () => demo)
    $.ui.status(statusLineText(demo))
    return demo
  }
  const [registry, selfId, now, config, titles, previous] = await Promise.all([
    readRegistry($), $.session.id(), $.clock.now(), configDir($), readTitles($), read($, snapshot),
  ])

  let warning = registry.problem
  const sessions = registry.sessions

  // Transcripts that grew since their context size was last read.
  const paths = new Map<string, string | null>()
  const files: HelperFile[] = []
  if (isFull && config) {
    for (const s of sessions) {
      const path = await findTranscript($, config, s)
      paths.set(s.sessionId, path)
      if (!path) continue
      const { size } = await $.fs.stat(path).catch(() => ({ size: -1 }))
      if (size >= 0 && tokenCache.get(path)?.size !== size) files.push({ path, mode: 'tokens' })
    }
  }

  // One helper run answers both; outside the pane, liveness is re-checked only once a minute or for new entries.
  const isAliveStale = isFull || now - alive.at > ALIVE_TTL_MS || sessions.some(s => !alive.checked.has(entryKey(s)))
  if (sessions.length && (isAliveStale || files.length)) {
    try {
      const reply = await runHelper($, { pids: isAliveStale ? sessions.map(s => s.pid) : [], files })
      if (isAliveStale) alive = { at: now, keys: keepAlive(sessions, reply), checked: new Set(sessions.map(entryKey)) }
      for (const f of reply.files) if (!f.error) tokenCache.set(f.path, { size: f.size, tokens: lastContextTokens(f.lines.join('\n')) })
    } catch (err) {
      warning = `Couldn't check which sessions are running (${(err as Error).message}).`
    }
  }
  const running = warning ? [] : sessions.filter(s => alive.keys.has(entryKey(s)))

  const rows: Row[] = running.map(s => ({
    key: `pid:${s.pid}`,
    name: s.name,
    isNamed: s.isNamed,
    title: titles[s.sessionId]?.title ?? null,
    value: titles[s.sessionId]?.value ?? null,
    status: s.status,
    waitingFor: s.waitingFor,
    cwd: s.cwd,
    pid: s.pid,
    sessionId: s.sessionId,
    updatedAt: s.updatedAt,
    isSelf: s.sessionId === selfId,
    git: null,
    tokens: null,
  }))

  if (isFull) {
    const taken = new Set(rows.map(r => samePath(r.cwd)))
    for (const path of await idleWorktrees($, taken)) {
      rows.push({
        key: `wt:${path}`, name: '(no session)', isNamed: true, title: null, value: null, status: 'worktree', waitingFor: null,
        cwd: path, pid: null, sessionId: '', updatedAt: 0, isSelf: false, git: null, tokens: null,
      })
    }
    const byCwd = new Map<string, Promise<Git | null>>()
    for (const row of rows) if (!byCwd.has(samePath(row.cwd))) byCwd.set(samePath(row.cwd), gitStatus($, row.cwd))
    for (const row of rows) {
      row.git = await byCwd.get(samePath(row.cwd))!
      const path = paths.get(row.sessionId)
      row.tokens = path ? tokenCache.get(path)?.tokens ?? null : null
    }
  } else {
    // Keep the last readings so the pane doesn't flicker between full scans.
    const prev = new Map((previous?.rows ?? []).map(r => [r.key, r]))
    for (const row of rows) {
      row.git = prev.get(row.key)?.git ?? null
      row.tokens = prev.get(row.key)?.tokens ?? null
    }
  }

  if (!warning && rows.length && !rows.some(r => r.isSelf)) {
    warning = "This session isn't in ~/.claude/sessions, so the list may be incomplete."
  }
  const next: Snapshot = { rows: sortRows(rows), scannedAt: now, warning }
  await update($, snapshot, () => next)
  $.ui.status(statusLineText(next))
  if (previous && !previous.warning && !next.warning) await notifyChanges($, previous, next)
  if (isFull && config) void refreshTitles($, config, rows, titles).catch(() => undefined)
  return next
}

// A toast when another session starts waiting on you, or finishes what it was doing.
// CLAUDE_FLEET_NOTIFY=0 turns these off.
async function notifyChanges($: EngineInterface, before: Snapshot, after: Snapshot) {
  if ((await $.env.get('CLAUDE_FLEET_NOTIFY')) === '0') return
  const was = new Map(before.rows.map(r => [r.key, r.status]))
  for (const row of after.rows) {
    const prev = was.get(row.key)
    if (row.isSelf || row.pid === null || prev === undefined || prev === row.status) continue
    if (needsYou(row.status) && !needsYou(prev)) $.ui.toast(`⚠ ${label(row)} needs you (${needText(row)})`)
    else if (isBusy(prev) && row.status === 'idle') $.ui.toast(`✓ ${label(row)} finished`)
  }
}

// --- Titles and resume value ---

async function readTitles($: EngineInterface) {
  return ((await $.store.get(TITLES_KEY)) ?? {}) as Record<string, TitleEntry>
}

async function makeTitle($: EngineInterface, path: string, idleText: string) {
  const reply = await runHelper($, { pids: [], files: [{ path, mode: 'ends' }] })
  const ends = reply.files[0]
  if (!ends || ends.error) return null
  const first = userPrompts(ends.head).slice(0, 3)
  const latest = userPrompts(ends.tail).slice(-2).filter(p => !first.includes(p))
  if (first.length === 0) return null

  const r = await $.model.complete({
    model: 'haiku',
    system: LABEL_SYSTEM,
    prompt: labelPrompt(first, latest, lastAssistantText(ends.tail).slice(-800), idleText),
    maxTokens: 80,
    effort: 'low',
  })
  return r.isAnswered ? parseLabel(r.text) : null
}

// Titles a few untitled sessions per scan, and retitles one whose transcript has doubled.
// CLAUDE_FLEET_TITLES=0 turns titling off (no Haiku calls); sessions then show Claude Code's own names.
async function refreshTitles($: EngineInterface, config: string, rows: Row[], titles: Record<string, TitleEntry>, limit = TITLES_PER_SCAN) {
  if ((await $.env.get('CLAUDE_FLEET_TITLES')) === '0') return 0
  const now = await $.clock.now()
  const due: { row: Row; path: string; size: number }[] = []
  for (const row of rows) {
    if (!row.sessionId || row.isNamed || titling.has(row.sessionId)) continue
    const path = await findTranscript($, config, row)
    if (!path) continue
    const { size } = await $.fs.stat(path)
    const known = titles[row.sessionId]
    if (!known || !known.value || size > known.size * 2) due.push({ row, path, size })
    if (due.length >= limit) break
  }

  for (const { row } of due) titling.add(row.sessionId)
  const made = await Promise.all(
    due.map(({ row, path, size }) =>
      makeTitle($, path, ago(now - row.updatedAt).replace('now', 'under a minute'))
        .then(made => (made ? { sessionId: row.sessionId, ...made, size } : null))
        .catch(() => null),
    ),
  )
  for (const { row } of due) titling.delete(row.sessionId)

  const fresh = made.filter(m => m !== null)
  if (fresh.length === 0) return 0
  const all = await readTitles($)
  for (const m of fresh) all[m.sessionId] = { title: m.title, size: m.size, value: m.value }
  await $.store.set(TITLES_KEY, all)
  const byId = new Map(fresh.map(m => [m.sessionId, m]))
  await update($, snapshot, snap =>
    snap && {
      ...snap,
      rows: snap.rows.map(r => {
        const m = byId.get(r.sessionId)
        return m ? { ...r, title: m.title, value: m.value ?? null } : r
      }),
    },
  )
  return fresh.length
}

// --- Pane actions on the selected row ---

async function selectedRow($: EngineInterface) {
  const [snap, key] = await Promise.all([read($, snapshot), read($, selected)])
  return snap?.rows.find(r => r.key === key) ?? null
}

async function copyResume($: EngineInterface, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const row = await selectedRow($)
  if (!row) return $.ui.toast('Select a session first (↑/↓)')
  if (isDemo(row)) return $.ui.toast('Demo mode: nothing to resume for made-up sessions')
  const command = resumeCommand(row)
  const copied = await $.ui.copy({ text: command, surface })
  $.ui.toast(copied.isCopied ? `Copied: ${command}` : command)
}

async function openPane($: EngineInterface) {
  await update($, isOpen, () => true)
  await $.ui.open({ id: PANE, title: 'Fleet', focus: true })
  await scan($, true)
}

// --- Hooks ---

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fleet',
      description: 'Every running Claude session: who needs you, branch, context size and whether it has gone cold',
      argumentHint: '[list|stale|retitle|help]',
    })

    let tick = 0
    $.clock.every(TICK_MS, () => {
      tick += 1
      void (async () => {
        const open = await read($, isOpen)
        if (open || tick % STATUS_EVERY_TICKS === 0) await scan($, open)
      })().catch(() => undefined)
    })
    void scan($, false).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'fleet' }, async ($, e) => {
    const [sub = ''] = e.args.trim().split(/\s+/)

    if (sub === 'help') return { text: HELP }
    if (sub === 'list') return { text: asTable(await scan($, true)) }
    if (sub === 'stale') return { text: staleReport(await scan($, true)) }

    if (sub === 'retitle') {
      await $.store.delete(TITLES_KEY)
      const config = await configDir($)
      const snap = await scan($, true)
      const made = config ? await refreshTitles($, config, snap.rows, {}, Infinity) : 0
      return { text: `Titled ${made} sessions.\n\n${asTable(await scan($, true))}` }
    }

    if (sub) return { text: `Unknown: /fleet ${sub}\n\n${HELP}` }
    await openPane($)
    return { text: 'Fleet pane opened. /fleet help lists the rest.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  })

  on('ui.focus', async ($, e, next) => {
    if (e.requestId === PANE && e.element?.startsWith('row:')) {
      const key = e.element.slice('row:'.length)
      await update($, selected, () => key)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [snap, picked] = await Promise.all([read($, snapshot), read($, selected)])
    return paneView(
      $.ui.resolve(e),
      { snap, picked, columns: e.props.bodyColumns, rows: e.viewport?.rows ?? 24 },
      {
        select: key => { void update($, selected, () => key) },
        copy: press => { void copyResume($, press.surface) },
        refresh: () => { void scan($, true) },
      },
    )
  })
}
