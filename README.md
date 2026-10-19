# fleet for Windows

A Claude Code mod that shows every Claude session running on this Windows machine: which ones need you, what each is working on, the state of its code, and how much context it holds.

It is a Windows port of [Dubbus/claude-fleet](https://github.com/Dubbus/claude-fleet), whose original needs `ps`, `kill`, `head` and `tail` and so doesn't run on Windows. This version only reads: it shows sessions and never closes them.

```
10 sessions · 2 busy · 1 need you · 6 safe to close · 841k tokens to re-cache

  ● Payments webhook retry bug         waiting   api                    fix/webhooks ✎1          2m        141k
▸ ● Auth middleware refactor           busy      api                    feat/auth ✎4 ↑2         now        182k
  ● Onboarding copy rewrite            shell     web                    feat/onboarding ✎6 ↑1   now         58k
  ● Flaky checkout test triage         idle      web                    main ✎2                 25m         96k
  ◐ Release notes for v2.4             idle      docs                   main                     3d    44k cold
  ○ Regex for ISO dates                idle      web                    main                     2d    14k cold
  ◐ Postgres migration dry run         idle      api                    master ↑2               12d   338k cold

Payments webhook retry bug is waiting on: permission prompt
```

That's the demo fleet (`CLAUDE_FLEET_DEMO=1`), cut short.

## What you get

- **Status line**, always on: `⧉ 6 sessions · 2 busy · 1 need you`. It's empty while only one session runs.
- **`/fleet`** opens a live pane, refreshed every 5 seconds. For each session it shows:
  - a short **title** for what the session is about, written by Haiku, instead of names like `api-5d`
  - its status: busy in yellow, waiting on you in red, and what it waits on (a permission prompt, say)
  - the project folder and git branch, uncommitted files (✎) and commits ahead or behind (↑↓)
  - how long since it was last active
  - its **context size**, marked `cold` once the prompt cache has expired: resuming it then pays to cache that whole context again
  - whether it's worth resuming: **●** in progress, **◐** finished (write a handoff, then close it), **○** light (just close it)

  In the pane, ↑/↓ selects a session, **c** copies a PowerShell command that resumes it, and **r** refreshes.
- **A toast when another session needs you**, for example when it's waiting on a permission prompt, and another when a busy session finishes.
- **`/fleet list`**, **`/fleet stale`** (idle over a week), **`/fleet retitle`** and **`/fleet help`** print the same information as text, also in `claude -p`.

## Install

Needs Claude Code 2.1.302 or later on Windows, with function hooks on (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`).

At the prompt of a terminal session:

```
/plugin install fleet --marketplace daldaman/claude-fleet-windows
```

From a shell:

```
claude plugin install fleet --marketplace daldaman/claude-fleet-windows
```

In the desktop app, click + next to the prompt box, then Plugins. Choose Add marketplace with `daldaman/claude-fleet-windows`, then Add plugin.

## Settings

Set these as environment variables, for example in the `env` block of `~/.claude/settings.json`.

| Variable | Effect |
| --- | --- |
| `CLAUDE_FLEET_TITLES=0` | No Haiku titles; sessions show Claude Code's own names. |
| `CLAUDE_FLEET_NOTIFY=0` | No toasts. |
| `CLAUDE_FLEET_DEMO=1` | Made-up sessions, for trying the pane or taking screenshots. |
| `CLAUDE_FLEET_REGISTRY` | Read the session list from another folder. |

## What it costs

- **Titles:** one small Haiku call per session that has no title yet, two per refresh at most, and only while the pane is open or a `/fleet` command runs. A title is made again only when its conversation has doubled in size. Titles are kept between sessions.
- **PowerShell:** each refresh starts one PowerShell process, which checks which sessions are still running and reads the end of each transcript that grew. With the pane closed, that happens at most once a minute.

## How the port works

- **Which sessions run:** Claude Code writes one file per session to `~/.claude/sessions`, along with the start time of the session's process. The PowerShell helper asks Windows for those processes. A process counts only if its start time matches the file's, so a crashed session whose pid Windows has handed to another program never shows up.
- **Context size:** the helper reads a transcript's end from disk and finds the last reply's token usage there, starting with the last 512 KB and reading further back up to 8 MB. Windows has no `tail`, and the mod's own file reads stop at 4 MiB, while a long session's transcript runs past 14 MB.
- **Statuses:** Claude Code reports `shell` while a session runs a command. That counts as busy, not as needing you.
- **PowerShell:** `pwsh` first, then Windows PowerShell 5.1, which every Windows has. The script runs with `-Command`, so execution policy doesn't apply. It's passed as one line, because a multi-line `-Command` runs nothing when Claude Code starts PowerShell.

Left out of the original for now: closing sessions, saving conversations, handoffs, the handoff offer above the prompt, and the pause on `/exit`.

## Limits

- `~/.claude/sessions` is internal to Claude Code, not an API, so a release can move or reshape it. When it does, fleet says what's wrong instead of showing an empty list. This version was tested on Claude Code 2.1.302.
- Sessions in the Claude desktop app show up too, but the resume command it copies is for a terminal.

## Develop

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

MIT, with the original's copyright kept. See [LICENSE](LICENSE).
