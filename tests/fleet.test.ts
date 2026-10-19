import { describe, expect, mock, test } from 'claude-code/testing'

import { basename, resumeCommand, statusLineText } from '../hooks/lib/format.ts'
import { HELPER_SCRIPT, helperArgv, isSessionProcess, parseHelperReply } from '../hooks/lib/helper.ts'
import { lastContextTokens, parseGitStatus, parseRegistryEntry, samePath, transcriptPath } from '../hooks/lib/parse.ts'
import { isBusy, needsYou } from '../hooks/lib/rules.ts'

import type { Row } from '../types'

// --- A made-up machine: five registry files, three of them live sessions ---

const HOME = 'C:\\Users\\me'
const CONFIG = `${HOME}/.claude`
const REG = `${CONFIG}/sessions`
const CWD = 'C:\\Users\\me\\code\\app'
const NOW = 1_800_000_000_000
const start = (pid: number) => String(134_000_000_000_000_000 + pid * 10_000_000_000)

const ENTRIES: Record<number, Record<string, unknown>> = {
  // This session, running a shell command.
  101: { sessionId: 'sid-self', status: 'shell', updatedAt: NOW - 1000 },
  // Waiting on a permission prompt.
  102: { status: 'waiting', waitingFor: 'permission prompt', updatedAt: NOW - 120_000 },
  // Crashed; Windows has since given its pid to another program.
  103: { status: 'idle' },
  // Crashed; nothing runs under its pid.
  104: { status: 'idle' },
  // Idle for two hours: its cache has gone cold.
  105: { status: 'idle', updatedAt: NOW - 2 * 3600_000 },
}
const registryFile = (pid: number) =>
  JSON.stringify({
    pid, sessionId: `sid-${pid}`, cwd: CWD, procStart: start(pid), name: `app-${pid}`, nameSource: 'derived',
    bridgeSessionId: 'never-read', updatedAt: NOW - 60_000, ...ENTRIES[pid],
  })
const transcript105 = transcriptPath(CONFIG, { cwd: CWD, sessionId: 'sid-105' })
const usageLine = JSON.stringify({
  type: 'assistant', isSidechain: false,
  message: { usage: { input_tokens: 10, cache_read_input_tokens: 240_000, cache_creation_input_tokens: 9_990 } },
})

const RUNNING = [
  { pid: 101, name: 'claude', start: start(101) },
  { pid: 102, name: 'claude', start: start(102) },
  { pid: 103, name: 'chrome', start: '1' },
  { pid: 105, name: 'claude', start: start(105) },
]

// Answers the plugin's `$` calls the way Windows and Claude Code would on that machine.
// A hook answering a call on `$` hands back `{ value }`.
const machine = (on: any, opts: { powershells: string[]; ran: string[][]; status: (string | undefined)[] }) => {
  const answer = (event: string, fn: (e: any) => unknown) => on(event, (_$: any, e: any) => ({ value: fn(e) }))
  mock.env(on, { USERPROFILE: HOME, CLAUDE_FLEET_TITLES: '0' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  answer('session.id', () => 'sid-self')
  answer('session.cwd', () => CWD)
  answer('ui.status', e => { opts.status.push(e.text) })
  answer('ui.toast', () => undefined)
  // The engine hands hooks the path resolved, so compare one spelling of each.
  const is = (path: string, want: string) => samePath(path) === samePath(want)
  answer('fs.exists', e => is(e.path, REG) || is(e.path, transcript105))
  answer('fs.list', e =>
    is(e.path, REG)
      ? Object.keys(ENTRIES).map(pid => ({ name: `${pid}.json`, kind: 'file', size: 300, mtimeMs: NOW, isLink: false }))
      : [])
  answer('fs.read', e => registryFile(Number(e.path.match(/(\d+)\.json$/)[1])))
  answer('fs.stat', () => ({ kind: 'file', size: 5000, mtimeMs: NOW, isLink: false }))
  on('process.run', (_$: any, e: any) => {
    opts.ran.push([...e.argv])
    const [exe] = e.argv
    if (exe === 'git') {
      return {
        value: e.argv.includes('status')
          ? { exitCode: 0, stdout: '# branch.head main\r\n# branch.ab +1 -0\r\n1 .M N... 100644 100644 100644 a b f.R\r\n', stderr: '' }
          : { exitCode: 128, stdout: '', stderr: 'not a git repository' },
      }
    }
    if (!opts.powershells.includes(exe)) throw new Error(`${exe}: not found`)
    const req = JSON.parse(e.init.stdin)
    const reply = {
      procs: RUNNING.filter(p => req.pids.includes(p.pid)),
      files: req.files.map((f: any) => ({ path: f.path, size: 5000, lines: [usageLine], head: '', tail: '', error: null })),
    }
    return { value: { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' } }
  })
}

describe('fleet on Windows', () => {
  test('falls back to Windows PowerShell when pwsh is not installed', async ($, on) => {
    const ran: string[][] = []
    machine(on, { powershells: ['powershell'], ran, status: [] })
    const r: any = await $.command.run({ command: 'fleet', args: 'list' } as any)
    expect(r.text).toContain('app-102')
    expect(ran.filter(a => a[0] !== 'git').map(a => a[0])).toEqual(['pwsh', 'powershell'])
  })

  test('lists live sessions only, with who needs you, git and cold context', async ($, on) => {
    const ran: string[][] = []
    const status: (string | undefined)[] = []
    machine(on, { powershells: ['pwsh', 'powershell'], ran, status })
    const r: any = await $.command.run({ command: 'fleet', args: 'list' } as any)
    const text = String(r.text)

    expect(text).toContain('3 sessions · 1 busy · 1 need you')
    for (const live of ['app-101', 'app-102', 'app-105']) expect(text).toContain(live)
    // 103's pid now belongs to another program and 104's process is gone.
    expect(text).not.toContain('app-103')
    expect(text).not.toContain('app-104')
    expect(text).toContain('app-102 is waiting on: permission prompt')
    expect(text).toContain('250k cold')
    expect(text).toContain('main ✎1 ↑1')
    expect(status.at(-1)).toBe('⧉ 3 sessions · 1 busy · 1 need you')

    const helper = ran.find(a => a[0] !== 'git')!
    expect(helper.slice(1, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(helper[4]).toBe(HELPER_SCRIPT)
  })
})

describe('the pane', () => {
  test('draws the demo fleet on the terminal and the desktop app', async ($, on) => {
    const toasts: string[] = []
    mock.env(on, { CLAUDE_FLEET_DEMO: '1' })
    mock.store(on)
    mock.clock(on, { now: NOW })
    on('ui.status', () => ({ value: undefined }))
    on('ui.toast', (_$: any, e: any) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await $.command.run({ command: 'fleet', args: 'list' } as any)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'fleet', surface, component: 'Pane', requestId: 'fleet',
        props: { title: 'Fleet', isFocused: true, bodyColumns: 120, placement: 'inline', scroll: { top: 0, bodyRows: 30 } } as any,
        viewport: { columns: 140, rows: 40 } as any,
      })
      expect(await ui.find({ type: 'Text', text: /Payments webhook retry bug/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /waiting on: permission prompt/ })).toBeDefined()
      await ui.press({ key: 'copy' })
      expect(toasts.at(-1)).toContain('Select a session first')
      await ui.press({ key: 'refresh' })
      await ui.unmount()
    }
  })
})

describe('the PowerShell helper', () => {
  test('its script survives Windows command-line quoting as one line', () => {
    expect(HELPER_SCRIPT.includes('"')).toBe(false)
    expect(HELPER_SCRIPT.includes('`')).toBe(false)
    expect(HELPER_SCRIPT.includes('\n')).toBe(false)
    expect(HELPER_SCRIPT).toContain('} finally { $fs.Dispose() }; } catch {')
    expect(helperArgv('pwsh')[0]).toBe('pwsh')
  })

  test('reads replies however ConvertTo-Json shaped them', () => {
    const one = parseHelperReply('\uFEFF{"procs":{"pid":7,"name":"claude","start":"5"},"files":null}')
    expect(one.procs).toEqual([{ pid: 7, name: 'claude', start: '5' }])
    expect(one.files).toEqual([])
    const file = parseHelperReply('{"procs":[],"files":[{"path":"p","size":3,"lines":"x","error":null}]}').files[0]
    expect(file.lines).toEqual(['x'])
    expect(file.error).toBeNull()
  })

  test('tells a session from a program that reused its pid', () => {
    expect(isSessionProcess('134367494004333233', { pid: 1, name: 'claude', start: '134367494004333233' })).toBe(true)
    expect(isSessionProcess('134367494004333233', { pid: 1, name: 'claude', start: '134367494999999999' })).toBe(false)
    expect(isSessionProcess(null, { pid: 1, name: 'claude', start: '' })).toBe(true)
    expect(isSessionProcess(null, { pid: 1, name: 'chrome', start: '' })).toBe(false)
  })
})

describe('Windows paths and statuses', () => {
  test('finds the transcript folder Claude Code makes from a Windows path', () => {
    expect(transcriptPath('C:/Users/me/.claude', { cwd: 'C:\\Users\\me\\code\\app', sessionId: 's' }))
      .toBe('C:/Users/me/.claude/projects/C--Users-me-code-app/s.jsonl')
    expect(samePath('C:\\Users\\Me\\code\\')).toBe(samePath('c:/users/me/code'))
    expect(basename('C:\\Users\\me\\code\\app')).toBe('app')
  })

  test('copies a resume command PowerShell runs as written', () => {
    const row = { cwd: "C:\\Users\\me\\O'Brien lab", sessionId: 'abc' } as Row
    expect(resumeCommand(row)).toBe("Set-Location -LiteralPath 'C:\\Users\\me\\O''Brien lab'; claude --resume abc")
  })

  test('counts shell as busy, not as needing you', () => {
    expect(isBusy('shell')).toBe(true)
    expect(needsYou('shell')).toBe(false)
    expect(needsYou('waiting')).toBe(true)
  })

  test('reads only the registry fields it names', () => {
    const entry = parseRegistryEntry(registryFile(102), 0)!
    expect(entry.waitingFor).toBe('permission prompt')
    expect(entry.procStart).toBe(start(102))
    expect(Object.keys(entry).sort()).toEqual(
      ['cwd', 'isNamed', 'name', 'pid', 'procStart', 'sessionId', 'status', 'updatedAt', 'waitingFor'])
  })

  test('parses git and usage the way Windows writes them', () => {
    expect(parseGitStatus('# branch.head main\r\n# branch.ab +0 -2\r\n? new.txt\r\n')).toEqual(
      { branch: 'main', dirty: 1, ahead: 0, behind: 2, hasUpstream: true })
    expect(lastContextTokens(`cut mid-entry"}\n${usageLine}\n`)).toBe(250_000)
  })

  test('shows nothing in the status line when this is the only session', () => {
    expect(statusLineText({ rows: [], scannedAt: NOW, warning: null })).toBeUndefined()
  })
})
