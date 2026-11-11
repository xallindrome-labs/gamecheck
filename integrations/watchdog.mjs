// Standalone copy of gamecheck's src/watchdog.ts, compiled, with no dependencies beyond Node.
// holdPriority (keeps every Chrome process at the priority you ask for) and watchMemory (kills Chrome past a memory ceiling). Both take a Playwright Browser. Needs lean.mjs beside it.
// Copy it into your own harness. test/integrations.test.ts fails if it drifts from the source.
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { priorityValue } from './lean.mjs';
const exec = promisify(execFile);
/** Resident memory in MB of each given process id, summed. Undefined when it cannot be read on this platform. */
export async function memoryOf(pids) {
    if (pids.length === 0)
        return 0;
    try {
        if (process.platform === 'win32') {
            const { stdout } = await exec('tasklist', ['/FO', 'CSV', '/NH']);
            const wanted = new Set(pids);
            let kb = 0;
            for (const line of stdout.split(/\r?\n/)) {
                const cells = line.match(/"([^"]*)"/g);
                if (cells && cells.length >= 5 && wanted.has(Number((cells[1] ?? '').replace(/"/g, ''))))
                    kb += Number((cells[4] ?? '').replace(/[^0-9]/g, '')) || 0;
            }
            return kb / 1024;
        }
        const { stdout } = await exec('ps', ['-o', 'rss=', '-p', pids.join(',')]);
        return stdout.split(/\s+/).reduce((sum, cell) => sum + (Number(cell) || 0), 0) / 1024;
    }
    catch {
        return undefined;
    }
}
/**
 * Watches the total memory of every process the browser has (the browser, GPU, utility and renderer processes) once a
 * second and kills them all when it passes limitMb, so a runaway page ends instead of eating the PC. Anything waiting
 * on the page then fails with a closed-browser error; the Session reports `memoryExceeded` for the reason. A runaway
 * that grows faster than one poll can overshoot the ceiling for up to a second. Returns the function that stops it.
 */
export function watchMemory(browser, limitMb, onExceeded, pollMs = 1000) {
    let stopped = false;
    let timer;
    const tick = async () => {
        if (stopped)
            return;
        try {
            const cdp = await browser.newBrowserCDPSession();
            try {
                const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo'));
                const pids = processInfo.map((one) => one.id);
                const usedMb = await memoryOf(pids);
                if (usedMb !== undefined && usedMb > limitMb && !stopped) {
                    stopped = true;
                    onExceeded({ limitMb, usedMb: Math.round(usedMb) });
                    for (const pid of pids) {
                        try {
                            process.kill(pid, 'SIGKILL');
                        }
                        catch { /* already gone */ }
                    }
                    return;
                }
            }
            finally {
                await cdp.detach().catch(() => { });
            }
        }
        catch {
            if (stopped)
                return;
        }
        if (!stopped) {
            timer = setTimeout(() => { void tick(); }, pollMs);
            timer.unref();
        }
    };
    timer = setTimeout(() => { void tick(); }, pollMs);
    timer.unref();
    return () => { stopped = true; if (timer)
        clearTimeout(timer); };
}
/**
 * Puts every process of the browser at the given priority and keeps it there. Chrome raises its foreground renderer (the
 * process that runs the game) above normal whatever priority it was started at, so lowering the launcher is not enough:
 * this sets each process by id, once now and again every pollMs for the renderers Chrome starts later. normal leaves
 * Chrome's own choices alone. Resolves, once the first pass is done, to the function that stops it.
 */
export async function holdPriority(browser, priority, pollMs = 1000) {
    const value = priorityValue(priority);
    if (value === undefined)
        return () => { };
    let stopped = false;
    let timer;
    const pass = async () => {
        try {
            const cdp = await browser.newBrowserCDPSession();
            try {
                const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo'));
                for (const one of processInfo) {
                    try {
                        os.setPriority(one.id, value);
                    }
                    catch { /* gone, or not ours to change */ }
                }
            }
            finally {
                await cdp.detach().catch(() => { });
            }
        }
        catch { /* the browser is closing */ }
    };
    await pass();
    const loop = () => {
        timer = setTimeout(() => { void pass().then(() => { if (!stopped)
            loop(); }); }, pollMs);
        timer.unref();
    };
    loop();
    return () => { stopped = true; if (timer)
        clearTimeout(timer); };
}
