import assert from 'node:assert/strict';
import { mock, test, type TestContext } from 'node:test';
import { createClipper, obsAuthentication, type ClipperOptions, type ClipperSocket } from '../src/clips.js';
import { collectClips } from '../src/clipsCollect.js';

type Frame = { op: number; d: Record<string, unknown> };

class FakeSocket implements ClipperSocket {
  sent: Frame[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(JSON.parse(data) as Frame); }
  close(): void { this.closed = true; }
  receive(op: number, d: Record<string, unknown>): void { this.onmessage?.({ data: JSON.stringify({ op, d }) }); }
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i += 1) await new Promise((done) => setImmediate(done));
  assert.ok(ok(), 'timed out waiting');
};

function setup(t: TestContext, extra: Partial<ClipperOptions> = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.after(() => mock.timers.reset());
  const sockets: FakeSocket[] = [];
  const clipper = createClipper({
    postRollMs: 3_000, cooldownMs: 10_000, log: () => undefined,
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    ...extra,
  });
  t.after(() => clipper.close());
  return { clipper, sockets };
}

test('clipper: Hello is answered with Identify, then the save waits out the post-roll and the record is broadcast with its path', async (t) => {
  const { clipper, sockets } = setup(t);
  const socket = sockets[0] as FakeSocket;
  socket.receive(0, { obsWebSocketVersion: '5.0.0', rpcVersion: 1 });
  assert.deepEqual(socket.sent[0], { op: 1, d: { rpcVersion: 1 } });
  socket.receive(2, { negotiatedRpcVersion: 1 });

  assert.equal(clipper.moment('parry', { screenX: 0.25 }), true);
  mock.timers.tick(2_999);
  assert.equal(socket.sent.length, 1);
  mock.timers.tick(1);
  assert.equal(socket.sent[1]?.d.requestType, 'SaveReplayBuffer');

  socket.receive(5, { eventType: 'ReplayBufferSaved', eventData: { savedReplayPath: 'C:/v/clip.mkv' } });
  assert.deepEqual(clipper.records()[0], { trigger: 'parry', meta: { screenX: 0.25 }, wallTime: clipper.records()[0]?.wallTime, postRollMs: 3_000, also: [], outputPath: 'C:/v/clip.mkv' });
  const broadcast = socket.sent[2]?.d as { requestType: string; requestData: { eventData: { source: string; record: { outputPath: string } } } };
  assert.equal(broadcast.requestType, 'BroadcastCustomEvent');
  assert.equal(broadcast.requestData.eventData.source, 'clipper');
  assert.equal(broadcast.requestData.eventData.record.outputPath, 'C:/v/clip.mkv');
});

test('clipper: outputPath is read when savedReplayPath is absent', async (t) => {
  const { clipper, sockets } = setup(t, { postRollMs: 0 });
  const socket = sockets[0] as FakeSocket;
  socket.receive(0, {});
  socket.receive(2, {});
  clipper.moment('a');
  mock.timers.tick(0);
  socket.receive(5, { eventType: 'ReplayBufferSaved', eventData: { outputPath: 'C:/v/other.mp4' } });
  assert.equal(clipper.records()[0]?.outputPath, 'C:/v/other.mp4');
});

test('clipper: with a password it answers the challenge with the SHA-256 string, and without one it still identifies', async (t) => {
  const { sockets } = setup(t, { password: 'secret' });
  const socket = sockets[0] as FakeSocket;
  socket.receive(0, { rpcVersion: 1, authentication: { challenge: 'ch', salt: 'sa' } });
  await until(() => socket.sent.length > 0);
  const expected = await obsAuthentication('secret', 'sa', 'ch');
  assert.equal(socket.sent[0]?.d.authentication, expected);
  assert.match(expected, /^[A-Za-z0-9+/]{43}=$/);
});

test('clipper: when OBS wants a password and none was given, it logs that and still identifies', (t) => {
  const logs: string[] = [];
  const bare = setup(t, { log: (line) => logs.push(line) }).sockets[0] as FakeSocket;
  bare.receive(0, { rpcVersion: 1, authentication: { challenge: 'ch', salt: 'sa' } });
  assert.deepEqual(bare.sent[0], { op: 1, d: { rpcVersion: 1 } });
  assert.equal(logs.length, 1);
});

test('obsAuthentication matches the obs-websocket v5 recipe', async () => {
  const { createHash } = await import('node:crypto');
  const sha = (text: string): string => createHash('sha256').update(text).digest('base64');
  assert.equal(await obsAuthentication('pw', 'salt', 'challenge'), sha(sha('pwsalt') + 'challenge'));
});

test('clipper: a trigger waits out its cooldown, and moments inside one post-roll share one save', async (t) => {
  const { clipper, sockets } = setup(t);
  const socket = sockets[0] as FakeSocket;
  socket.receive(0, { rpcVersion: 1 });
  socket.receive(2, {});
  assert.equal(clipper.moment('a'), true);
  assert.equal(clipper.moment('a'), false);
  assert.equal(clipper.moment('b', { n: 1 }), true);
  mock.timers.tick(3_000);
  assert.equal(socket.sent.filter((frame) => frame.d.requestType === 'SaveReplayBuffer').length, 1);
  assert.deepEqual(clipper.records()[0]?.also, [{ trigger: 'b', meta: { n: 1 } }]);
  mock.timers.tick(7_000);
  assert.equal(clipper.moment('a'), true);
});

test('clipper: cooldownMs can be a function of the trigger', async (t) => {
  const { clipper, sockets } = setup(t, { cooldownMs: (trigger) => (trigger === 'quick' ? 0 : 60_000) });
  const socket = sockets[0] as FakeSocket;
  socket.receive(0, {});
  socket.receive(2, {});
  assert.equal(clipper.moment('quick'), true);
  assert.equal(clipper.moment('quick'), true);
  assert.equal(clipper.moment('slow'), true);
  assert.equal(clipper.moment('slow'), false);
});

test('clipper: without OBS it logs once, ignores moments and retries no sooner than reconnectMs', (t) => {
  const logs: string[] = [];
  const { clipper, sockets } = setup(t, { log: (line) => logs.push(line) });
  sockets[0]?.onclose?.();
  assert.equal(logs.length, 1);
  assert.equal(clipper.moment('a'), false);
  mock.timers.tick(29_999);
  assert.equal(sockets.length, 1);
  mock.timers.tick(1);
  assert.equal(sockets.length, 2);
  sockets[1]?.onclose?.();
  assert.equal(logs.length, 1);
});

test('clipper: never throws into the game when the socket cannot be made', (t) => {
  const { clipper } = setup(t, { createSocket: () => { throw new Error('no socket'); } });
  assert.equal(clipper.moment('a', {}), false);
  assert.doesNotThrow(() => clipper.close());
});

test('collect: writes <video>.json from the record a clipper broadcast, and ignores other events', async (t) => {
  const socket = new FakeSocket();
  const writes: [string, string][] = [];
  const collector = collectClips({ createSocket: () => socket, write: (file, text) => writes.push([file, text]), log: () => undefined });
  t.after(() => collector.close());
  socket.receive(0, { rpcVersion: 1 });
  assert.deepEqual(socket.sent[0], { op: 1, d: { rpcVersion: 1 } });
  const record = { trigger: 'parry', meta: { screenX: 0.7 }, wallTime: 1, postRollMs: 3_000, also: [], outputPath: 'C:\v\clip.2026.mkv' };
  socket.receive(5, { eventType: 'CustomEvent', eventData: { source: 'someone-else', record } });
  socket.receive(5, { eventType: 'CustomEvent', eventData: { source: 'clipper', record: { trigger: 'x' } } });
  assert.equal(writes.length, 0);
  socket.receive(5, { eventType: 'CustomEvent', eventData: { source: 'clipper', record } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.[0], 'C:\v\clip.2026.json');
  assert.deepEqual(JSON.parse(writes[0]?.[1] ?? ''), record);
});
