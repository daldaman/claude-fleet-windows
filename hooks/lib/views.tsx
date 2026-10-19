// What the pane draws. It gets the surface's elements and plain callbacks, never `$`:
// the engine only follows `$` within register.tsx, so everything that touches it stays there.
import type { ElementTable, UiPressArgument } from 'claude-code'

import type { Snapshot } from '../../types'

import { ago, basename, ctxText, fit, fitLabel, gitText, glyph, label, summaryParts, VALUE_COLOR } from './format.ts'
import { isBusy, isCold, isStale, needsYou, windowCounts } from './rules.ts'

export type PaneActions = {
  select: (key: string) => void
  copy: (press: UiPressArgument) => void
  refresh: () => void
}

export type PaneView = {
  snap: Snapshot | null
  picked: string | null
  // The pane body's width and the viewport's height, in cells.
  columns: number
  rows: number
}

export const paneView = (el: ElementTable, view: PaneView, act: PaneActions) => {
  const { Box, Button, Text } = el
  const { snap, picked } = view
  if (!snap) return <Text dimColor>Scanning…</Text>

  const now = snap.scannedAt
  const counts = windowCounts(snap.rows)
  const hasGit = snap.rows.some(r => r.git)
  const [headline, details] = summaryParts(snap)
  const waiting = snap.rows.filter(r => r.pid !== null && r.waitingFor && needsYou(r.status))
  const ctxW = 10
  const projW = Math.max(8, Math.min(20, Math.floor(view.columns * 0.16)))
  const gitW = hasGit ? Math.max(6, Math.min(22, Math.floor(view.columns * 0.2))) : 0
  const nameW = Math.max(10, view.columns - 4 - 9 - projW - gitW - 5 - ctxW - 5)
  const room = Math.max(1, view.rows - 7 - waiting.length)

  return (
    <Box flexDirection="column">
      {snap.warning ? <Text color="red" wrap="wrap">⚠ {snap.warning}</Text> : null}
      <Text bold wrap="truncate-end">{headline}</Text>
      {details ? <Text dimColor wrap="truncate-end">{details}</Text> : null}
      <Text> </Text>
      {snap.rows.slice(0, room).map((r, i) => {
        const isPicked = r.key === picked
        const stale = r.pid !== null && isStale(r, now)
        const color = isBusy(r.status) ? 'yellow' : needsYou(r.status) && r.pid !== null ? 'red' : undefined
        const cold = r.tokens !== null && isCold(r, now)
        return (
          <Box key={r.key}>
            <Button
              key={`row:${r.key}`}
              plain
              label={isPicked ? '▸' : r.isSelf ? '•' : ' '}
              autoFocus={i === 0 && picked === null ? true : undefined}
              onPress={() => act.select(r.key)}
            />
            <Text color={r.value ? VALUE_COLOR[r.value] : undefined} dimColor={r.value === 'light'}>{` ${glyph(r)} `}</Text>
            <Text bold={r.isSelf || isPicked} inverse={isPicked} color={r.isSelf ? 'cyan' : undefined} dimColor={stale && !isPicked} wrap="truncate-end">
              {fitLabel(r, counts, nameW)}
            </Text>
            <Text> </Text>
            <Text color={color} dimColor={!color}>{fit(r.status, 9)}</Text>
            <Text dimColor={stale}>{fit(basename(r.cwd), projW)} </Text>
            {hasGit ? (
              <Text color={r.git?.dirty ? 'magenta' : undefined} dimColor={!r.git || stale}>{fit(gitText(r.git), gitW)}</Text>
            ) : null}
            <Text dimColor>{(r.pid === null ? '' : ago(now - r.updatedAt)).padStart(4)} </Text>
            <Text color={cold && (r.tokens ?? 0) >= 500_000 ? 'red' : cold ? 'blue' : undefined} dimColor={!cold}>
              {ctxText(r, now).padStart(ctxW)}
            </Text>
          </Box>
        )
      })}
      {snap.rows.length > room ? <Text dimColor>  +{snap.rows.length - room} more (/fleet list)</Text> : null}
      {waiting.map(r => (
        <Text key={`waiting:${r.key}`} color="red" wrap="truncate-end">  ⚠ {label(r)} is waiting on: {r.waitingFor}</Text>
      ))}
      <Text> </Text>
      <Box>
        <Button key="copy" label="Copy resume" hotkey="c" onPress={act.copy} />
        <Text> </Text>
        <Button key="refresh" label="Refresh" hotkey="r" onPress={act.refresh} />
      </Box>
      <Text dimColor wrap="truncate-end">● in progress  ◐ finished: hand off  ○ light · ctx = tokens a resume re-caches · cold = cache expired</Text>
    </Box>
  )
}
