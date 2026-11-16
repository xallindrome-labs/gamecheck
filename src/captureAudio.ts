import type { BrowserContext } from 'playwright';

export interface AudioCue {
  at: number;
  src: string;
  offset: number;
  duration: number | null;
  rate: number;
  gain: number;
  loop: boolean;
}

export interface CaptureAudio {
  finish(from: number, seconds: number, timeScale: number): Promise<{ cues: AudioCue[]; wav: string }>;
}

function pageAudio(): void {
  interface Play extends AudioCue {
    key: string;
    stop: number | null;
    loopStart: number;
    loopEnd: number;
  }
  const urls = new WeakMap<ArrayBuffer, string>();
  const names = new WeakMap<AudioBuffer, string>();
  const keys = new WeakMap<AudioBuffer, string>();
  const buffers = new Map<string, { rate: number; channels: Float32Array[] }>();
  const edges = new WeakMap<AudioNode, Set<AudioNode>>();
  const sources = new WeakMap<AudioBufferSourceNode, Play>();
  const media = new WeakMap<HTMLMediaElement, Play>();
  const plays: Play[] = [];
  let next = 0;
  let rebuilding = false;
  const now = (): number => performance.now() / 1000;

  const fetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const response = await fetch.apply(this, args);
    const read = response.arrayBuffer;
    response.arrayBuffer = async () => {
      const data = await read.call(response);
      urls.set(data, response.url || String(args[0] instanceof Request ? args[0].url : args[0]));
      return data;
    };
    return response;
  };
  const response = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'response');
  if (response?.get) {
    const get = response.get;
    Object.defineProperty(XMLHttpRequest.prototype, 'response', {
      ...response,
      get(this: XMLHttpRequest): unknown {
        const data: unknown = get.call(this);
        // A load listener can run after the game's onload handler has already decoded the response.
        if (data instanceof ArrayBuffer) urls.set(data, this.responseURL);
        return data;
      },
    });
  }
  const decode = BaseAudioContext.prototype.decodeAudioData;
  BaseAudioContext.prototype.decodeAudioData = function (data: ArrayBuffer, ok?: DecodeSuccessCallback | null, fail?: DecodeErrorCallback | null) {
    const url = urls.get(data);
    const remember = (buffer: AudioBuffer): void => { if (url) names.set(buffer, url); };
    const promise = decode.call(this, data, (buffer) => { remember(buffer); ok?.(buffer); }, fail);
    void promise.then(remember, () => {});
    return promise;
  };

  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (this: AudioNode, ...args: [AudioNode | AudioParam, number?, number?]) {
    const result = Reflect.apply(connect, this, args) as AudioNode | undefined;
    const destination = args[0];
    if (destination instanceof AudioNode) {
      let linked = edges.get(this);
      if (!linked) { linked = new Set(); edges.set(this, linked); }
      linked.add(destination);
    }
    return result;
  } as typeof connect;
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function (this: AudioNode, ...args: [(number | AudioNode | AudioParam)?, number?, number?]) {
    Reflect.apply(disconnect, this, args);
    const destination = args[0];
    if (destination instanceof AudioNode) edges.get(this)?.delete(destination);
    else edges.delete(this);
  } as typeof disconnect;
  const gainOnPath = (node: AudioNode, seen = new Set<AudioNode>()): number | undefined => {
    if (seen.has(node)) return undefined;
    seen.add(node);
    if (node instanceof AudioDestinationNode) return 1;
    for (const destination of edges.get(node) ?? []) {
      const gain = gainOnPath(destination, new Set(seen));
      if (gain !== undefined) return gain * (node instanceof GainNode ? node.gain.value : 1);
    }
    return undefined;
  };
  const copy = (buffer: AudioBuffer): string => {
    let key = keys.get(buffer);
    if (!key) { key = `buffer:${++next}`; keys.set(buffer, key); }
    if (!buffers.has(key)) buffers.set(key, {
      rate: buffer.sampleRate,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice()),
    });
    return key;
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, offset = 0, duration?: number) {
    // Call the native method first: invalid starts must not become cues.
    if (duration === undefined) start.call(this, when, offset);
    else start.call(this, when, offset, duration);
    if (rebuilding || !this.buffer) return;
    const key = copy(this.buffer);
    const play: Play = {
      at: now() + Math.max(0, when - this.context.currentTime), src: names.get(this.buffer) ?? key, key,
      offset, duration: duration ?? null, rate: this.playbackRate.value * 2 ** (this.detune.value / 1200),
      gain: gainOnPath(this) ?? 1, loop: this.loop, stop: null, loopStart: this.loopStart, loopEnd: this.loopEnd,
    };
    plays.push(play);
    sources.set(this, play);
  };
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (when = 0) {
    stop.call(this, when);
    const play = sources.get(this);
    if (play && !rebuilding) play.stop = now() + Math.max(0, when - this.context.currentTime);
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const active = media.has(this) && !this.paused && !this.ended;
    const result = play.call(this);
    if (rebuilding || active) return result;
    const src = this.currentSrc || this.src || `media:${++next}`;
    const cue: Play = {
      at: now(), src, key: src, offset: this.currentTime, duration: null, rate: this.playbackRate,
      gain: this.muted ? 0 : this.volume, loop: this.loop, stop: null, loopStart: 0, loopEnd: 0,
    };
    plays.push(cue);
    media.set(this, cue);
    void result.catch(() => { const index = plays.indexOf(cue); if (index >= 0) plays.splice(index, 1); media.delete(this); });
    return result;
  };
  const pause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    pause.call(this);
    const cue = media.get(this);
    if (cue) cue.stop = now();
    media.delete(this);
  };

  const api: CaptureAudio = {
    async finish(from, seconds, timeScale) {
      rebuilding = true;
      const sampleRate = 48_000;
      const context = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * sampleRate)), sampleRate);
      const decoded = new Map<string, AudioBuffer>();
      const cues: AudioCue[] = [];
      for (const cue of plays) {
        if (cue.at >= from + seconds / timeScale || (cue.stop !== null && cue.stop <= from)) continue;
        let buffer = decoded.get(cue.key);
        if (!buffer) {
          const stored = buffers.get(cue.key);
          if (stored) {
            buffer = context.createBuffer(stored.channels.length, stored.channels[0]?.length ?? 1, stored.rate);
            stored.channels.forEach((channel, index) => buffer?.copyToChannel(channel as Float32Array<ArrayBuffer>, index));
          } else if (!cue.src.startsWith('media:')) {
            try { buffer = await context.decodeAudioData(await (await fetch.call(window, cue.src, { signal: AbortSignal.timeout(5000) })).arrayBuffer()); } catch { /* A stream or a CORS-blocked media URL has no decodable buffer. */ }
          }
          if (buffer) decoded.set(cue.key, buffer);
        }
        const duration = cue.duration === null ? Infinity : cue.duration / Math.max(cue.rate, 1e-9);
        const naturalEnd = buffer && !cue.loop ? cue.at + (buffer.duration - cue.offset) / Math.max(cue.rate, 1e-9) : Infinity;
        const end = Math.min(cue.stop ?? Infinity, cue.at + duration, naturalEnd, from + seconds / timeScale);
        if (end <= from || end <= cue.at) continue;
        cues.push({ at: (cue.at - from) * timeScale, src: cue.src, offset: cue.offset, duration: (end - cue.at) * timeScale, rate: cue.rate, gain: cue.gain, loop: cue.loop });
        if (!buffer || cue.rate <= 0) continue;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = cue.rate / timeScale;
        source.loop = cue.loop;
        source.loopStart = cue.loopStart;
        source.loopEnd = cue.loopEnd;
        const gain = context.createGain();
        gain.gain.value = cue.gain;
        source.connect(gain).connect(context.destination);
        let offset = cue.offset + Math.max(0, from - cue.at) * cue.rate;
        const loopEnd = cue.loopEnd > cue.loopStart ? Math.min(cue.loopEnd, buffer.duration) : buffer.duration;
        if (cue.loop && offset >= loopEnd && loopEnd > cue.loopStart) offset = cue.loopStart + (offset - cue.loopStart) % (loopEnd - cue.loopStart);
        source.start(Math.max(0, cue.at - from) * timeScale, offset);
        source.stop((end - from) * timeScale);
      }
      const rendered = await context.startRendering();
      const data = new ArrayBuffer(44 + rendered.length * 4);
      const view = new DataView(data);
      const word = (at: number, value: string): void => { for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i)); };
      word(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); word(8, 'WAVE'); word(12, 'fmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true);
      view.setUint16(32, 4, true); view.setUint16(34, 16, true); word(36, 'data'); view.setUint32(40, data.byteLength - 44, true);
      const left = rendered.getChannelData(0);
      const right = rendered.getChannelData(1);
      for (let i = 0; i < rendered.length; i += 1) {
        view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, left[i] ?? 0)) * 32767), true);
        view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, right[i] ?? 0)) * 32767), true);
      }
      const bytes = new Uint8Array(data);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return { cues, wav: btoa(binary) };
    },
  };
  (window as unknown as { __gamecheckAudio: CaptureAudio }).__gamecheckAudio = api;
}

export async function installCaptureAudio(context: BrowserContext): Promise<void> {
  await context.addInitScript(pageAudio);
}
