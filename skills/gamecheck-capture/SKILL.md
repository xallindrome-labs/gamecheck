---
name: gamecheck-capture
description: Write and capture a browser-game shot with frame-perfect video and the game's own sound using gamecheck.
---

Write a shot in the existing scenario JSON format, with `capture: { from, fps, viewport, scale }`.
`from` is the first step to film (1-based, default 1); fps defaults to 30, scale to 1. Use a safe filename for `id`.

- Wait out intros in setup steps before `capture.from`.
- Switch off first-time hint cards through the game's save or test hooks.
- Drive aim with the game's own test commands rather than the mouse.
- Keep the action near the player and choose a crop focus before filming.
- Avoid banner moments, including wave starts and clears.
- Use `advance` and `key` to drive time. `eval` and `snapshot` can read state or issue commands but must not draw or step the clock themselves. Polling steps are also advanced one frame at a time.
- Check games that read the wall clock with `compare` first.

Run `npx gamecheck capture shot.json --out captures --mux --terse`. ffmpeg must be on PATH, or named by
`GAMECHECK_FFMPEG`. Software rendering is the pixel reference and can take hundreds of milliseconds per frame;
`--gpu` is a faster draft. The output is `<id>.mp4`, `<id>.wav` and `<id>.cues.json`.
`gamecheck_capture` in MCP returns only paths, seconds and counts.

Check two or three frames with ffmpeg before using a capture: extract frames near the beginning, middle and end,
then use local pixel checks or have the user review them. Never send frames to the model.
Check the sound against the cue log too. Filters, panners, reverb, live automation, oscillators and AudioWorklets
are skipped or approximated in the rebuilt WAV. Web Worker and OffscreenCanvas games are not frame-exact.
