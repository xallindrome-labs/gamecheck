// Standalone copy of gamecheck's src/lean.ts, compiled, with no dependencies beyond Node.
// The lean launch options: a smaller canvas, lighter Chrome, low priority.
// Copy it into your own harness. test/integrations.test.ts fails if it drifts from the source.
import os from 'node:os';
/** A quarter of the pixels of the 1280x720 default: draw cost, in software, grows with the area. */
export const LEAN_VIEWPORT = { width: 640, height: 360 };
/**
 * Chrome features a test never uses. None of them touch rendering, timers or the game's own code, so results do not move;
 * they only stop Chrome doing background work (component updates, sync, phishing checks, extension machinery).
 */
export const LEAN_ARGS = [
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-domain-reliability',
    '--disable-breakpad',
    '--disable-hang-monitor',
    '--metrics-recording-only',
    '--no-first-run',
    '--no-default-browser-check',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=Translate,MediaRouter,OptimizationHints,BackForwardCache,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater',
];
export function launchTuning(tuning) {
    const args = tuning.lean ? [...LEAN_ARGS] : [];
    if (tuning.memoryMb !== undefined && !(tuning.memoryMb >= 256))
        throw new Error('memoryMb must be at least 256: Chrome alone starts near 300 MB');
    return {
        args,
        viewport: tuning.viewport ?? (tuning.lean ? { ...LEAN_VIEWPORT } : { width: 1280, height: 720 }),
        priority: tuning.priority ?? (tuning.lean ? 'low' : 'normal'),
    };
}
/** The operating-system value for a priority, or undefined for normal (leave Chrome's own choice alone). */
export function priorityValue(priority) {
    const c = os.constants.priority;
    return priority === 'low' ? c.PRIORITY_BELOW_NORMAL : priority === 'high' ? c.PRIORITY_ABOVE_NORMAL : undefined;
}
/**
 * Sets this process's priority and hands back a function that restores it. Launch Chrome in between: a child starts at its
 * parent's priority class (Windows documents this for below-normal parents; Unix niceness is inherited), and so do the
 * processes Chrome starts later. The driver then goes back to normal so the stepping loop is not starved. Never throws:
 * a refused change leaves the priority alone.
 */
export function lowerPriority(priority) {
    if (priority === 'normal')
        return () => { };
    const c = os.constants.priority;
    const before = (() => { try {
        return os.getPriority(0);
    }
    catch {
        return undefined;
    } })();
    try {
        os.setPriority(0, priority === 'low' ? c.PRIORITY_BELOW_NORMAL : c.PRIORITY_ABOVE_NORMAL);
    }
    catch {
        return () => { };
    }
    return () => { if (before !== undefined) {
        try {
            os.setPriority(0, before);
        }
        catch { /* keep what we have */ }
    } };
}
