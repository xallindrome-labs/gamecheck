import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const lockPath = (): string => process.env.GAMECHECK_LOCK ?? join(tmpdir(), 'gamecheck.lock');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One headless run at a time on a machine: browsers are heavy. The lock is a file holding { pid, what, at }; a holder
 * that is gone is taken over. Point GAMECHECK_LOCK at another tool's lock file (same format) to share it.
 */
export async function takeLock(what: string): Promise<() => void> {
  const file = lockPath();
  let told = false;
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }), { flag: 'wx' });
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try { unlinkSync(file); } catch { /* already gone */ }
      };
      process.once('exit', release);
      return release;
    } catch {
      let holder: { pid: number; what: string; at: string } | undefined;
      try { holder = JSON.parse(readFileSync(file, 'utf8')) as typeof holder; } catch { holder = undefined; }
      const fresh = ((): boolean => { try { return Date.now() - statSync(file).mtimeMs < 5000; } catch { return false; } })();
      if (holder ? !alive(holder.pid) : !fresh) {
        try { unlinkSync(file); } catch { /* another run took it first */ }
        continue;
      }
      if (holder && !told) console.error(`[gamecheck] waiting for another headless run: ${holder.what} (pid ${holder.pid}, since ${holder.at})`);
      told = told || Boolean(holder);
      await wait(holder ? 5000 : 500);
    }
  }
}
