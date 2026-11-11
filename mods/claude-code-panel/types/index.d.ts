/** What gamecheck's progress file holds (gamecheck src/progress.ts, version 1). */
export type Result = { id: string; ok: boolean; ms: number; why?: string }

export type Snapshot = {
  version: 1
  runId: string
  label: string
  state: 'running' | 'done'
  startedAt: number
  updatedAt: number
  total: number
  finished: number
  passed: number
  failed: number
  current?: {
    id: string
    proves?: string
    phase: 'opening' | 'running'
    startedAt: number
    stepIndex: number
    stepCount: number
    step: string
    gameMs: number
  }
  recent: Result[]
  failures: Result[]
}

declare module 'claude-code' {
  interface PluginState {
    'gamecheck-progress': {
      snapshot: Shaped<Snapshot | null>
      /** Wall clock at the last poll, so "updated 12 s ago" moves while a run goes. */
      now: number
      /** The run whose end the person has already been told about. */
      announced: string | null
    }
  }
}
