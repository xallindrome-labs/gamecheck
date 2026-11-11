# gamecheck

Run a browser game faster than real time, headless. gamecheck drives the game's clock itself instead of waiting on it, so a
100 second boss fight takes a few seconds of wall time, and the same run gives the same result every time. What you use
that speed for is up to you: tests, fight-length tables, soak runs, or an AI agent playing and inspecting a game.

It sits on top of [Playwright](https://playwright.dev) and was extracted from a Phaser 3 action game whose headless runs
were slow for two reasons: CPU (software) rendering, and fights that ran in real time.

## What it does

- **Runs game time faster.** Two ways to drive time, so most engines work:
  - `raf`: a virtual clock for `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now` and `Date.now`,
    installed before the page loads. Works with any engine that runs on those (Phaser, PixiJS, three.js, your own loop).
  - `phaser`: steps `Phaser.Game` directly. With `render: false` it uses Phaser's `headlessStep`, which runs every scene's
    logic and skips drawing, the fastest mode there is.
- **Tells you whether the fast run can be trusted.** `gamecheck compare` plays a scenario on the real clock and on the stepped
  one and lists every verdict and observed value that differs. Use it before you rely on a stepped result.
- **Keeps the machine light.** One headless run at a time, through a lock file (a holder that is gone is taken over).
- **Speaks tersely.** `--terse` prints one line, so an agent reading it spends few tokens.

## Quick start

```sh
npm install @xallindrome-labs/gamecheck playwright
npx playwright install chromium
npx gamecheck run examples/walker.json
npx gamecheck compare examples/walker.json
```

A scenario is JSON: steps, then expectations on what you recorded.

```json
{
  "id": "walker.arrives",
  "engine": "raf",
  "url": "http://localhost:5173",
  "steps": [
    { "do": "advance", "ms": 4000 },
    { "do": "snapshot", "as": "early", "expr": "({ done: window.state.done })" },
    { "do": "waitFor", "expr": "window.state.done", "timeoutMs": 3000 },
    { "do": "key", "key": "ArrowRight", "ms": 500 }
  ],
  "expect": [
    { "at": "early", "path": "done", "equals": false, "why": "not there after four seconds" }
  ]
}
```

Steps: `advance`, `key` (held for game time), `waitFor` (an expression, polled in game time), `snapshot`, `eval`, and two
that turn a loop you would otherwise hand-write into a step:

- `measure`: game time until an expression is true, with a cap and stall detection (a progress expression that stops
  changing). It is a fight-length table in one step: `{ "do": "measure", "until": "boss.dead", "as": "fight", "capMs": 900000, "progress": "boss.hp", "stallMs": 60000 }`.
- `soak`: play on for N game milliseconds, checking an invariant every poll and pressing a seeded random key now and then.
  The first violation comes back with its game time and seed, so it replays exactly: a softlock or out-of-bounds hunt.

Expectations: `equals`, `oneOf`, `min`, `max` at a dotted path in a snapshot.

From code:

```ts
import { openGame } from '@xallindrome-labs/gamecheck';

const game = await openGame({ url, engine: 'raf', stepped: true });
await game.until('window.__ready');
await game.press('Space', 120);
await game.advance(60_000);
console.log(await game.evaluate('window.state'));
await game.close();
```

With the `phaser` engine, give it an expression for your `Phaser.Game`: `{ engine: 'phaser', gameRef: 'window.__GAME__' }`. Add `render: false` (CLI: `--no-render`) for the fastest steps. A Phaser game runs by itself in real time from the moment it is created until gamecheck takes over, so read values as a change over an advance (before and after) when you need them to repeat exactly; the `raf` engine's clock is virtual from the page's first line and has no such gap.

## For agents (MCP)

`gamecheck-mcp` is an MCP server over stdio. Results are short on purpose, to spend few tokens.

```json
{ "mcpServers": { "gamecheck": { "command": "npx", "args": ["-y", "-p", "@xallindrome-labs/gamecheck", "gamecheck-mcp"] } } }
```

Whole scenarios: `gamecheck_run` and `gamecheck_compare`.

Step by step, for an agent that wants to look, act and look again. Time stands still between calls, so nothing happens
that the agent did not ask for:

| Tool | What it does |
| --- | --- |
| `gamecheck_open` | Opens a page and takes the run lock. Closes itself after 10 idle minutes. |
| `gamecheck_step` | Advances `ms` or `frames`, or `until` an expression is true. `inputs` presses keys on the game clock. `report` reads named expressions before and after and says which changed. Capped per call, with a wall-time budget that is flagged when it cuts a step short. |
| `gamecheck_state` | Named expressions, or the page's own digest. Rounded, and capped with a dropped count. |
| `gamecheck_watch` | Plays on and returns a summary per expression (start, end, min, max, mean, slope, when the extremes happened, a capped timeline of changes) instead of raw samples. |
| `gamecheck_screenshot` | A PNG, for how something looks. Costs far more than a state read. |
| `gamecheck_close` | Lets the lock go. |

A game can help the agent read it cheaply by offering a curated digest, which `gamecheck_state` uses when no expressions
are given:

```js
window.__gamecheck = { state: () => ({ phase: 2, boss: { hp: 120, at: [40, 80] }, goals: ['reach the gate'] }) };
```

## Cheaper runs

Stepped time already removes the waiting. These options cut what the browser costs the machine.

| Option | CLI | What it does |
| --- | --- | --- |
| `render: false` | `--no-render` | Phaser: step with `headlessStep`, which updates every scene and skips drawing. Anything that reads values the renderer computes (camera view, world-point conversion) goes stale. |
| `drawEvery: N` | `--draw-every N` | Phaser: draw one frame in N, step the rest without drawing. The last frame of every advance is always drawn, so what you read afterwards is current. |
| `lean: true` | `--lean` | A 640x360 window, a lighter Chrome (background networking, sync, extensions and component updates off), and low priority. |
| `viewport` | `--viewport 800x450` | The window size. Overrides the lean size. |
| `priority` | `--priority low\|normal\|high` | Chrome's priority class. `low` (below normal) is the lean default so the PC stays usable; a plain run stays at `normal`; `high` is only above normal. |
| `memoryMb` | `--memory-mb 1500` | A ceiling on the total memory of every Chrome process (at least 256; Chrome alone starts near 300 MB), checked once a second. Past it the browser is killed and the run fails with "memory ceiling exceeded", instead of a runaway page eating the PC. A very fast runaway can overshoot for up to a second. |

All of them are also arguments of the MCP tools (`gamecheck_run`, `gamecheck_compare`, `gamecheck_open`).

Measured with `node bench/cost.mjs` (30 game seconds of a Phaser WebGL page with 2,500 sprites, software-rendered, two runs each, Windows):

| | Wall time | Chrome CPU | Peak memory |
| --- | --- | --- | --- |
| Draw every frame (baseline) | 17.7 s | 276 s | 552 MB |
| `--lean` | 17.7 s | 277 s | 552 MB |
| `--lean --draw-every 4` | 3.7 s | 57 s | 438 MB |
| `--lean --no-render` | 0.1 s | 0.5 s | 304 MB |

Drawing is the cost: skipping it is about 150 times faster and uses about 500 times less CPU; drawing one frame in four is about 4.7 times faster. `--lean` on its own changed nothing in this test, because the page fixes its own canvas size, so shrinking the window does not change what is drawn. The smaller window only saves work for a game whose canvas follows the window. The lighter Chrome flags did not show up in a 30-second run either; they stop background work rather than frame work.

## Watching a run

`gamecheck run a.json b.json c.json --progress` plays the scenarios one after another and rewrites a small JSON file as
it goes (`.gamecheck/progress.json`, or `--progress-file <path>`, or the `GAMECHECK_PROGRESS` environment variable).
The MCP server writes it by default, for runs, comparisons and interactive sessions, so an agent's work shows up in the
panel; set `GAMECHECK_PROGRESS=off` to stop that. The file holds the run's counts, the scenario in flight, its
current step and game time, the last results, and every failure. It is replaced whole and atomically, so anything can
poll it: a terminal, a CI step, an editor panel. The CLI writes it only when asked for, and a failed write never stops a run.

From code, `new Progress({ file, total })` is the writer, and it is a `ScenarioObserver` you can hand to `runScenario`.

There is a Claude Code panel that draws this file live: `mods/claude-code-panel` (a bar, the scenario and step now,
passed and failed counts, recent results, failures, and a "stalled" warning when the file stops changing). Install it at
the prompt of a terminal Claude Code session:

```
/plugin install gamecheck-progress --marketplace xallindrome-labs/gamecheck
```

or from a shell: `claude plugin install gamecheck-progress --marketplace xallindrome-labs/gamecheck`. Then run a check with
`--progress` from the folder Claude Code is open in (or point the mod's "Progress file" setting at the file), and type
`/gamecheck` if the pane does not open by itself.

## Using the pieces in your own harness

If you already have a Playwright harness, you do not need the rest of gamecheck to get the cheaper-run and panel pieces.
`integrations/` has three dependency-free files to copy (a test keeps them identical to the sources):

- `progress.mjs`: the progress-file writer the Claude Code panel reads (`new Progress({ file, total })`, then `begin`, `step`, `tick`, `end`, `finish`).
- `lean.mjs`: the lean Chrome flags, the small window size, and `launchTuning` to combine them with a priority and memory ceiling.
- `watchdog.mjs` (needs `lean.mjs` beside it): `holdPriority(browser, 'low')` keeps every Chrome process at that priority, and `watchMemory(browser, limitMb, onExceeded)` kills Chrome past a ceiling. Both take a Playwright `Browser`.

## Honest limits

- It drives game time, not the browser's. Anything that waits on real I/O (network, image decode) still takes real time;
  `until` yields to it between polls.
- With the `phaser` engine, timers the page registered before the clock started stay on real time. The `raf` engine has no
  such gap because it starts with the page.
- Playwright's own `page.clock` did not drive a Phaser game in our tests (frames did not advance with it), which is why
  this exists.
- `render: false` skips drawing, so anything that reads values the renderer computes goes stale: Phaser's camera view and
  world-point conversion, for one. Run `compare` on a scenario before relying on it, and use `render: true` where aiming or
  hit tests depend on the camera.
- Rendering is not time-warped: `--gpu` makes frames cheap, software rendering stays the reference for pixels. Take
  screenshots on the real clock.
- A game that reads the wall clock for gameplay (a `setTimeout`-based pause, say) is better checked on the real clock:
  run `compare` and look.
- `--gpu` picks Direct3D 11 on Windows and Metal on macOS. Other platforms have not been tried.

## Numbers

From the game it came out of, one run each, so read them as rough: a boss fight of 262 game seconds took 24.7 s of wall
time including 13 s of setup (about 380 s in real time with software rendering), and scenarios ran 2 to 4 times
faster, more on long ones. Short scenarios gain little, because page and scene loading stay in real time.

## Related work

gamecheck is not the first tool to run a browser game on a controlled clock, and it is young company. In a survey in
November 2026 we found these, from their READMEs and docs (not their source), several of them weeks old:

- [playproof](https://github.com/EmirhanOzl/playproof) (MIT): the closest. It injects a virtual clock before page scripts
  (frames, timers, `performance.now`, `Date`, CSS animations) with a seeded `Math.random`, says it gives identical frames
  across Canvas 2D, Phaser 3, PixiJS 8, three.js, Godot web and Unity WebGL, runs as an MCP server, and has a seeded `monkey`
  random player that reports hangs and soft-locks with a reproduce command. It states that the clock is not frame-exact for
  games that simulate in a Web Worker.
- [paprika3d](https://github.com/paprika3d/paprika3d) (Apache-2.0): an MCP server for three.js and WebGL pages with an injected,
  paused virtual clock, an `interact` tool with `until` and `expect`, and saved plays that can be re-run.
- [debuff](https://github.com/debuffjp/debuff) (MIT): a game framework with its own fixed-step clock, JSON scenarios,
  a seeded `fuzz` that emits a replay, and an MCP server. Only for games built on it.
- [clik-engine](https://pvydro.github.io/clik-engine/) (MIT): its test harness stops a Phaser game's loop and calls
  `headlessStep` at a fixed timestep, with seeded scripted, random-fuzz and policy strategies.
- Clock building blocks and neighbours: [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers) and Playwright's
  `page.clock`; [timeweb](https://github.com/tungs/timeweb) and [overcrank](https://github.com/upspawn/overcrank), which do it to
  record video; [chaosbringer](https://www.npmjs.com/package/chaosbringer), seeded random actions with invariants for web
  pages; OpenAI's `develop-web-game` skill (games expose `window.advanceTime(ms)`);
  [godot-mcp](https://github.com/satelliteoflove/godot-mcp), freeze and step tools for Godot. Godot, Unity and Bevy have
  native fixed-step modes too.

What we did not find in any of them, which is what gamecheck adds: a `compare` that plays a scenario on the real clock and on
the stepped one and diffs the results; a Phaser `headlessStep` adapter on top of an engine-agnostic clock; a soak run that
checks an invariant you write and replays from its seed; a `measure` step with a cap and a stall guard; and a lock shared
with other tools that run headless browsers. The survey was quick and search ranking is poor, so treat "did not find" as
exactly that. Try playproof too, and use whichever fits.

## License

MIT
