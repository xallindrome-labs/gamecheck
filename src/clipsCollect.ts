import { writeFileSync } from 'node:fs';
import { CUSTOM_EVENT_SOURCE, obsAuthentication, type ClipRecord, type ClipperSocket } from './clips.js';

export interface CollectOptions {
  url?: string;
  password?: string;
  reconnectMs?: number;
  log?: (message: string) => void;
  createSocket?: (url: string) => ClipperSocket;
  write?: (file: string, text: string) => void;
}

/** Where a clip's record goes: the video's own name with .json. */
export function sidecarPath(video: string): string {
  return `${video.replace(/\.[^./\\]+$/, '')}.json`;
}

/** Connects to OBS and writes <video>.json next to each replay the game's clipper saved. */
export function collectClips(options: CollectOptions = {}): { close(): void } {
  const url = options.url ?? 'ws://localhost:4455';
  const password = options.password ?? process.env.OBS_PASSWORD;
  const log = options.log ?? ((message: string): void => console.log(message));
  const write = options.write ?? ((file: string, text: string): void => writeFileSync(file, text));
  if (!options.createSocket && typeof WebSocket === 'undefined') throw new Error('gamecheck clips collect needs Node 22 or newer, which has a global WebSocket');
  let socket: ClipperSocket | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const handle = async (made: ClipperSocket, text: string): Promise<void> => {
    const { op, d } = JSON.parse(text) as { op: number; d?: Record<string, unknown> };
    if (op === 0) {
      const identify: Record<string, unknown> = { rpcVersion: 1 };
      const auth = d?.authentication as { challenge: string; salt: string } | undefined;
      if (auth && password !== undefined) identify.authentication = await obsAuthentication(password, auth.salt, auth.challenge);
      else if (auth) log('OBS asks for a password: pass --password or set OBS_PASSWORD');
      made.send(JSON.stringify({ op: 1, d: identify }));
    } else if (op === 2) {
      log(`collecting from ${url}`);
    } else if (op === 5 && d?.eventType === 'CustomEvent') {
      const data = d.eventData as { source?: unknown; record?: ClipRecord } | undefined;
      if (data?.source !== CUSTOM_EVENT_SOURCE || typeof data.record?.outputPath !== 'string') return;
      const file = sidecarPath(data.record.outputPath);
      write(file, `${JSON.stringify(data.record, null, 2)}\n`);
      log(`wrote ${file}`);
    }
  };

  const connect = (): void => {
    if (closed) return;
    const made = options.createSocket ? options.createSocket(url) : (new WebSocket(url) as unknown as ClipperSocket);
    socket = made;
    made.onmessage = (event) => {
      try {
        void handle(made, typeof event.data === 'string' ? event.data : '').catch((error: unknown) => log(`could not handle a message: ${error instanceof Error ? error.message : String(error)}`));
      } catch {
        // A frame that is not v5 JSON is not ours.
      }
    };
    made.onclose = () => {
      socket = undefined;
      if (!closed) retry = setTimeout(connect, options.reconnectMs ?? 5_000);
    };
    made.onerror = () => undefined;
  };

  connect();
  return {
    close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
    },
  };
}
