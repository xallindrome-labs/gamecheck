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
npm install gamecheck playwright
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
import { openGame } from 'gamecheck';

const game = await openGame({ url, engine: 'raf', stepped: true });
await game.until('window.__ready');
await game.press('Space', 120);
await game.advance(60_000);
console.log(await game.evaluate('window.state'));
await game.close();
```

With the `phaser` engine, give it an expression for your `Phaser.Game`: `{ engine: 'phaser', gameRef: 'window.__GAME__' }`. Add `render: false` (CLI: `--no-render`) for the fastest steps.

## For agents (MCP)

`gamecheck-mcp` is an MCP server over stdio. Results are short on purpose, to spend few tokens.

```json
{ "mcpServers": { "gamecheck": { "command": "npx", "args": ["gamecheck-mcp"] } } }
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

gamecheck stands on ideas from others. [`@sinonjs/fake-timers`](https://github.com/sinonjs/fake-timers) and Playwright's
`page.clock` fake the browser's timers and frames; [timeweb](https://github.com/tungs/timeweb) and
[overcrank](https://github.com/upspawn/overcrank) do it to record video; OpenAI's `develop-web-game` skill has games expose
`window.advanceTime(ms)`; [godot-mcp](https://github.com/satelliteoflove/godot-mcp) gives agents freeze, step and
step-until tools, and a state digest, for Godot. What gamecheck adds for browser games is time you can compare, soak with
a seed, measure with a stall guard, and report to an agent tersely.

The closest relative we found is the multi-instance test harness in [clik-engine](https://pvydro.github.io/clik-engine/) (MIT),
which stops a Phaser game's loop and calls `headlessStep` at a fixed timestep, with seeded scripted, random-fuzz and policy
strategies and a pass/fail report. It is Phaser-specific, and its docs do not mention an MCP server or a real-versus-stepped
comparison. [chaosbringer](https://www.npmjs.com/package/chaosbringer) does seeded random actions with invariants and a repro
command, for web pages in general and without a virtual clock. Replit has written about faking the browser's time to render
video. Other engines do the equivalent natively (Godot's `--fixed-fps`, Unity's `Time.captureFramerate`). These notes are
from a quick survey, not an audit, and gamecheck is not the first tool to step a game's clock.

## License

MIT
