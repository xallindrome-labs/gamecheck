/** What a moment leaves behind: the sidecar the collector writes next to the saved video. */
export interface ClipRecord {
  trigger: string;
  meta: Record<string, unknown>;
  /** Wall clock, milliseconds since the epoch, when the moment was called. */
  wallTime: number;
  /** How long after the moment OBS was told to save, in milliseconds. */
  postRollMs: number;
  /** Other moments that landed inside the same post-roll and so share this clip. */
  also: { trigger: string; meta: Record<string, unknown> }[];
  /** Set when OBS reports the replay saved. */
  outputPath?: string;
}

/** The slice of the browser WebSocket the clipper uses, so a test can stand in for it. */
export interface ClipperSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

export interface ClipperOptions {
  /** obs-websocket v5 address; default ws://localhost:4455. */
  url?: string;
  /** The obs-websocket password, when OBS asks for one. */
  password?: string;
  /** How long after a moment OBS is told to save, so the clip holds what follows it; default 3000. */
  postRollMs?: number;
  /** The least time between two accepted moments of the same trigger; default 10 000. A function reads it afresh each time. */
  cooldownMs?: number | ((trigger: string) => number);
  /** The least time between connection attempts; default 30 000. */
  reconnectMs?: number;
  /** Called with a line of text for the first failure to reach OBS and for each saved clip; default console.info. */
  log?: (message: string) => void;
  /** Replaces the browser WebSocket. */
  createSocket?: (url: string) => ClipperSocket;
}

export interface Clipper {
  /** Marks a moment worth keeping. Never throws. Returns false when it was ignored (cooling down, or OBS not connected). */
  moment(trigger: string, meta?: Record<string, unknown>): boolean;
  /** Every record so far, saved or waiting. */
  records(): readonly ClipRecord[];
  close(): void;
}

export const CUSTOM_EVENT_SOURCE = 'clipper';

const RPC_VERSION = 1;

interface Message {
  op: number;
  d?: Record<string, unknown>;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The obs-websocket v5 authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export async function obsAuthentication(password: string, salt: string, challenge: string): Promise<string> {
  return sha256Base64(`${await sha256Base64(password + salt)}${challenge}`);
}

/** The path OBS reports for a saved replay, whichever name this obs-websocket version uses. */
export function savedReplayPath(eventData: Record<string, unknown> | undefined): string | undefined {
  const path = eventData?.savedReplayPath ?? eventData?.outputPath;
  return typeof path === 'string' ? path : undefined;
}

export function createClipper(options: ClipperOptions = {}): Clipper {
  const url = options.url ?? 'ws://localhost:4455';
  const postRollMs = Math.max(0, options.postRollMs ?? 3_000);
  const cooldownMs = options.cooldownMs ?? 10_000;
  const reconnectMs = options.reconnectMs ?? 30_000;
  const log = options.log ?? ((message: string): void => { if (typeof console !== 'undefined') console.info(message); });
  const all: ClipRecord[] = [];
  const awaitingPath: ClipRecord[] = [];
  const lastAccepted = new Map<string, number>();
  let socket: ClipperSocket | undefined;
  let identified = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let complained = false;
  let pending: { record: ClipRecord; timer: ReturnType<typeof setTimeout> } | undefined;
  let requestSerial = 0;

  const send = (op: number, d: Record<string, unknown>): void => {
    socket?.send(JSON.stringify({ op, d }));
  };
  const request = (requestType: string, requestData?: Record<string, unknown>): void => {
    requestSerial += 1;
    send(6, { requestType, requestId: `clip-${requestSerial}`, ...(requestData ? { requestData } : {}) });
  };

  const lost = (): void => {
    identified = false;
    socket = undefined;
    if (!complained) {
      complained = true;
      log(`clipper: OBS is not reachable at ${url}; clips are off until it is`);
    }
    if (!closed && retry === undefined) {
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, reconnectMs);
    }
  };

  const handle = async (message: Message): Promise<void> => {
    const d = message.d ?? {};
    if (message.op === 0) {
      const auth = d.authentication as { challenge: string; salt: string } | undefined;
      const identify: Record<string, unknown> = { rpcVersion: RPC_VERSION };
      if (auth) {
        if (options.password === undefined) {
          log('clipper: OBS asks for a password and none was given');
        } else {
          identify.authentication = await obsAuthentication(options.password, auth.salt, auth.challenge);
        }
      }
      send(1, identify);
    } else if (message.op === 2) {
      identified = true;
      complained = false;
    } else if (message.op === 5 && d.eventType === 'ReplayBufferSaved') {
      const path = savedReplayPath(d.eventData as Record<string, unknown> | undefined);
      const record = awaitingPath.shift();
      if (record && path !== undefined) {
        record.outputPath = path;
        log(`clipper: saved ${path}`);
        request('BroadcastCustomEvent', { eventData: { source: CUSTOM_EVENT_SOURCE, record } });
      }
    }
  };

  function connect(): void {
    if (closed || socket) return;
    try {
      const made = options.createSocket ? options.createSocket(url) : (new WebSocket(url) as unknown as ClipperSocket);
      socket = made;
      made.onmessage = (event) => {
        try {
          const text = typeof event.data === 'string' ? event.data : '';
          void handle(JSON.parse(text) as Message).catch(() => undefined);
        } catch {
          // A frame that is not v5 JSON is not ours.
        }
      };
      made.onclose = () => {
        if (socket === made) lost();
      };
      made.onerror = () => undefined;
    } catch {
      lost();
    }
  }

  connect();

  return {
    moment(trigger, meta = {}) {
      try {
        if (closed || !identified) return false;
        const now = Date.now();
        const cooldown = typeof cooldownMs === 'function' ? cooldownMs(trigger) : cooldownMs;
        const last = lastAccepted.get(trigger);
        if (last !== undefined && now - last < cooldown) return false;
        lastAccepted.set(trigger, now);
        if (pending) {
          pending.record.also.push({ trigger, meta });
          return true;
        }
        const record: ClipRecord = { trigger, meta, wallTime: now, postRollMs, also: [] };
        all.push(record);
        const timer = setTimeout(() => {
          pending = undefined;
          try {
            awaitingPath.push(record);
            request('SaveReplayBuffer');
          } catch {
            // OBS went away between the moment and the save.
          }
        }, postRollMs);
        pending = { record, timer };
        return true;
      } catch {
        return false;
      }
    },
    records: () => all,
    close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      if (pending) clearTimeout(pending.timer);
      try {
        socket?.close();
      } catch {
        // Already gone.
      }
      socket = undefined;
    },
  };
}
