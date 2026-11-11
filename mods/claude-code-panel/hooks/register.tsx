import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'

const PANE = 'gamecheck-progress'
const POLL_MS = 1000
/** A running snapshot not rewritten for this long is shown as stalled. */
const STALE_MS = 20_000
/** And a stalled one is dropped from the status line after this long. */
const GONE_MS = 5 * 60_000

const snapshot = atom({ plugin: 'gamecheck-progress', key: 'snapshot' } as const, null, {
  shape: 'snapshot-1',
})
const now = atom({ plugin: 'gamecheck-progress', key: 'now' } as const, 0)
const announced = atom({ plugin: 'gamecheck-progress', key: 'announced' } as const, null)

const seconds = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

const parse = (text: string): Snapshot | undefined => {
  try {
    const value = JSON.parse(text) as Snapshot
    return value && value.version === 1 && typeof value.runId === 'string' ? value : undefined
  } catch {
    // the writer replaces the file whole, so this is a half-seen read at worst: try again next tick
    return undefined
  }
}

export const register: Register = (on, options) => {
  const file = String(options.progressFile ?? '.gamecheck/progress.json')
  const autoOpen = options.autoOpen !== false
  let lastKey = ''

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gamecheck',
      description: 'Show the live gamecheck test run in a pane',
    })

    $.clock.every(POLL_MS, async () => {
      const text = await $.fs.read(file).catch(() => undefined)
      if (text === undefined) return
      const fresh = parse(text)
      if (!fresh) return
      const at = await $.clock.now()

      const key = `${fresh.runId}:${fresh.updatedAt}`
      const isNew = key !== lastKey
      const before = await read($, snapshot)
      if (isNew) {
        lastKey = key
        await update($, snapshot, () => fresh)
        if (autoOpen && before?.runId !== fresh.runId && fresh.state === 'running' && at - fresh.updatedAt < STALE_MS) {
          void $.ui.open({ id: PANE, title: 'gamecheck' })
        }
      }
      if (fresh.state === 'running') await update($, now, () => at)

      if (fresh.state === 'running' && at - fresh.updatedAt < GONE_MS) {
        const where = fresh.current ? ` · ${fresh.current.id}` : ''
        const bad = fresh.failed ? ` · ${fresh.failed} failed` : ''
        const count = fresh.total ? `${fresh.finished}/${fresh.total}` : `${fresh.finished}`
        $.ui.status(`gamecheck ${count}${bad}${where}`)
      } else {
        $.ui.status(undefined)
      }

      if (fresh.state === 'done' && (await read($, announced)) !== fresh.runId) {
        await update($, announced, () => fresh.runId)
        const verdict = fresh.failed ? `${fresh.failed} failed` : 'all passed'
        $.ui.toast(`gamecheck done: ${fresh.passed}/${fresh.finished} passed, ${verdict}`)
      }
    })

    return next(e)
  })

  on('command.run', { command: 'gamecheck' }, async $ => {
    await $.ui.open({ id: PANE, title: 'gamecheck' })
    return { text: `gamecheck pane opened, watching ${file}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const at = await read($, now)

    if (snap === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No gamecheck run yet.</Text>
          <Text dimColor>Start one with: gamecheck run --progress a.json b.json</Text>
          <Text dimColor>Watching {file}</Text>
        </Box>
      )
    }

    const wall = (snap.state === 'running' ? at || snap.updatedAt : snap.updatedAt) - snap.startedAt
    const idle = snap.state === 'running' && at > 0 ? at - snap.updatedAt : 0
    const isStalled = idle > STALE_MS
    const width = Math.max(10, Math.min(40, (e.props.bodyColumns ?? 60) - 16))
    const ratio = snap.total > 0 ? Math.min(1, snap.finished / snap.total) : 0
    const filled = Math.round(ratio * width)
    const eta =
      snap.state === 'running' && snap.finished > 0 && snap.total > snap.finished
        ? ` · about ${seconds((wall / snap.finished) * (snap.total - snap.finished))} left`
        : ''
    const state = snap.state === 'done' ? 'done' : isStalled ? 'stalled' : 'running'
    const stateColor = snap.state === 'done' ? (snap.failed ? 'red' : 'green') : isStalled ? 'yellow' : 'cyan'
    const cur = snap.current

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{snap.label}</Text> <Text color={stateColor}>{state}</Text>
          <Text dimColor> · {seconds(wall)}{eta}</Text>
        </Text>

        {snap.total > 0 && (
          <Text>
            <Text color={snap.failed ? 'yellow' : 'green'}>{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(width - filled)}</Text> {snap.finished}/{snap.total}
          </Text>
        )}
        <Text>
          <Text color="green">✓ {snap.passed} passed</Text>
          {'   '}
          <Text color={snap.failed ? 'red' : undefined} dimColor={!snap.failed}>
            ✗ {snap.failed} failed
          </Text>
        </Text>

        {cur && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>▶ {cur.id}</Text>
            {cur.proves !== undefined && <Text dimColor wrap="truncate-end">{cur.proves}</Text>}
            <Text>
              {cur.phase === 'opening' ? 'opening the page (or waiting for the headless lock)' : `step ${cur.stepIndex}/${cur.stepCount}: ${cur.step}`}
            </Text>
            <Text dimColor>
              game {(cur.gameMs / 1000).toFixed(1)} s · wall {seconds((at || snap.updatedAt) - cur.startedAt)}
            </Text>
          </Box>
        )}
        {isStalled && (
          <Text color="yellow">
            No update for {seconds(idle)}. The run may be waiting for the lock, or have stopped.
          </Text>
        )}

        {snap.failures.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="red">Failures</Text>
            {snap.failures.slice(-6).map(f => (
              <Text wrap="truncate-end">
                ✗ {f.id}
                <Text dimColor> {f.why ?? ''}</Text>
              </Text>
            ))}
            {snap.failures.length > 6 && <Text dimColor>… and {snap.failures.length - 6} earlier</Text>}
          </Box>
        )}

        {snap.recent.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Recent</Text>
            {snap.recent.slice(-6).map(r => (
              <Text wrap="truncate-end">
                <Text color={r.ok ? 'green' : 'red'}>{r.ok ? '✓' : '✗'}</Text> {r.id}
                <Text dimColor> {seconds(r.ms)}</Text>
              </Text>
            ))}
          </Box>
        )}

        {snap.state === 'done' && (
          <Box marginTop={1}>
            <Button key="clear" label="Clear" onPress={() => update($, snapshot, () => null)} />
          </Box>
        )}
      </Box>
    )
  })
}
