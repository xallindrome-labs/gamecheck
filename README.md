# gamecheck

Fast, deterministic headless checks for browser games. Instead of waiting on the clock, gamecheck drives the game loop
itself, so a 100 second boss fight takes a few seconds of wall time, and the same scenario gives the same answer every run.

It sits on top of [Playwright](https://playwright.dev) and was extracted from a Phaser 3 action game whose checks were
slow for two reasons: CPU (software) rendering, and fights that ran in real time.

## What it does

- **Steps game time by hand.** Two ways to drive time, so most engines work:
  - `raf`: a virtual clock for `requestAnimationFrame`, `setTimeout`, `setInterval`, `performance.now` and `Date.now`,
    installed before the page loads. Works with any engine that runs on those (Phaser, PixiJS, three.js, your own loop).
  - `phaser`: steps `Phaser.Game` directly with `game.step(time, delta)`. Can start at any point in a run.
- **Proves its own equivalence.** `gamecheck compare` plays a scenario on the real clock and on the stepped one and lists
  every verdict and observed value that differs. Use it before you trust a stepped result.
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

Steps: `advance`, `key` (held for game time), `waitFor` (an expression, polled in game time), `snapshot`, `eval`.
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

With the `phaser` engine, give it an expression for your `Phaser.Game`: `{ engine: 'phaser', gameRef: 'window.__GAME__' }`.

## Honest limits

- It drives game time, not the browser's. Anything that waits on real I/O (network, image decode) still takes real time;
  `until` yields to it between polls.
- With the `phaser` engine, timers the page registered before the clock started stay on real time. The `raf` engine has no
  such gap because it starts with the page.
- Playwright's own `page.clock` did not drive a Phaser game in our tests (frames did not advance with it), which is why
  this exists.
- Rendering is not time-warped: `--gpu` makes frames cheap, software rendering stays the reference for pixels. Take
  screenshots on the real clock.
- A game that reads the wall clock for gameplay (a `setTimeout`-based pause, say) is better checked on the real clock:
  run `compare` and look.
- `--gpu` picks Direct3D 11 on Windows and Metal on macOS. Other platforms have not been tried.

## Numbers

From the game it came out of, one run each, so read them as rough: a boss fight of 262 game seconds took 24.7 s of wall
time including 13 s of setup (about 380 s in real time with software rendering), and scenarios ran 2 to 4 times
faster, more on long ones. Short scenarios gain little, because page and scene loading stay in real time.

## License

MIT
