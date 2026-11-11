import { expect, mock, test } from 'claude-code/testing'

import type { Snapshot } from './types'

const PANE = {
  plugin: 'gamecheck-progress',
  component: 'Pane',
  requestId: 'gamecheck-progress',
  props: {
    title: 'gamecheck',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const RUN: Snapshot = {
  version: 1,
  runId: 'r1',
  label: 'gamecheck run',
  state: 'running',
  startedAt: 1_000_000,
  updatedAt: 1_030_000,
  total: 10,
  finished: 4,
  passed: 3,
  failed: 1,
  current: {
    id: 'boss-fight',
    proves: 'the boss can be killed',
    phase: 'running',
    startedAt: 1_025_000,
    stepIndex: 2,
    stepCount: 5,
    step: 'measure fight: until boss.dead',
    gameMs: 12_300,
  },
  recent: [
    { id: 'walk', ok: true, ms: 2000 },
    { id: 'jump', ok: false, ms: 3000, why: 'x was 4' },
  ],
  failures: [{ id: 'jump', ok: false, ms: 3000, why: 'x was 4' }],
}

const seed = (value: Snapshot | null, now = 1_031_000) => (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('state.get', (_, e) => {
    if (e.key === 'snapshot') return { value: { value: { shape: 'snapshot-1', value }, version: 1 } }
    if (e.key === 'now') return { value: { value: now, version: 1 } }
    return { value: { value: null, version: 1 } }
  })

test('the pane shows the scenario in flight, its step, the counts and the failures', async ($, on) => {
  seed(RUN)(on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /boss-fight/ }))?.text).toContain('boss-fight')
    expect((await ui.find({ type: 'Text', text: /step 2\/5: measure fight/ }))?.text).toContain('step 2/5')
    expect((await ui.find({ type: 'Text', text: /3 passed/ }))?.text).toContain('3 passed')
    expect((await ui.find({ type: 'Text', text: /1 failed/ }))?.text).toContain('1 failed')
    expect((await ui.find({ type: 'Text', text: /x was 4/ }))?.text).toContain('x was 4')
    expect((await ui.find({ type: 'Text', text: /4\/10/ }))?.text).toContain('4/10')
    await ui.unmount()
  }
})

test('a run that stopped writing is called stalled', async ($, on) => {
  seed(RUN, RUN.updatedAt + 60_000)(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /No update for/ }))?.text).toContain('No update for')
  await ui.unmount()
})

test('a finished run offers Clear, and nothing is in flight', async ($, on) => {
  seed({ ...RUN, state: 'done', finished: 10, passed: 9, failed: 1, current: undefined })(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /▶/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeDefined()
  await ui.unmount()
})

test('with no run yet the pane says how to start one', async ($, on) => {
  seed(null)(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /No gamecheck run yet/ }))?.text).toContain('No gamecheck run yet')
  await ui.unmount()
})

test('polling: the status line follows the file, and the end is announced once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_031_000 })
  let file = JSON.stringify(RUN)
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  on('fs.read', () => ({ value: file }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', () => ({ value: { command: 'gamecheck' } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  expect(statuses.at(-1)).toBe('gamecheck 4/10 · 1 failed · boss-fight')

  file = JSON.stringify({ ...RUN, state: 'done', finished: 10, passed: 9, failed: 1, current: undefined, updatedAt: 1_040_000 })
  await clock.advance(1000)
  await clock.advance(1000)
  expect(statuses.at(-1)).toBeUndefined()
  expect(toasts).toEqual(['gamecheck done: 9/10 passed, 1 failed'])
})

test('polling: a half-written or missing file is ignored', async ($, on) => {
  const clock = mock.clock(on, { now: 1_031_000 })
  const statuses: (string | undefined)[] = []
  on('fs.read', () => ({ value: '{"version":1,"runId":' }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'gamecheck' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(statuses).toEqual([])
})
