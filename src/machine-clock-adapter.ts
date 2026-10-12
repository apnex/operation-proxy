/**
 * The machine's clock and randomness (CONTRACT.md, PX5; zorg's target, EM11 and EM12).
 *
 * The clock is Linux's CLOCK_MONOTONIC in nanoseconds, as Node's `process.hrtime.bigint()` gives it: one
 * clock for every process on the machine, which a change to the wall clock does not move. Its timers are
 * `setTimeout`, whose waking is not the delay passing: on every wakeup the clock is read and, while the delay
 * has not passed on it, the timer is set again for the time remaining, rounded up, and no single wait asks
 * for more than `setTimeout` keeps. Invocation identities take the wall-clock time and the system's
 * randomness, as operation-call's own do. This is the only file that reads a clock or randomness for the
 * halves.
 */
import { randomBytes } from "node:crypto";
import type { IdentitySource } from "@apnex/operation-call";
import { msCeil, msToNs, type HopClock, type HopTimer } from "./hop-clock.js";

/** The longest delay `setTimeout` keeps; a longer one would fire at once. */
const LONGEST_TIMEOUT_MS = 2147483647;

/** CLOCK_MONOTONIC, and timers that honour their delay on it. */
export const machineClock: HopClock = Object.freeze({
	nowNs: (): bigint => process.hrtime.bigint(),
	schedule(delayMs: number, callback: () => void): HopTimer {
		const due = process.hrtime.bigint() + msToNs(Math.max(0, Math.ceil(delayMs)));
		let handle: ReturnType<typeof setTimeout>;
		const arm = (ms: number): void => {
			handle = setTimeout(wake, Math.min(ms, LONGEST_TIMEOUT_MS));
		};
		const wake = (): void => {
			const left = due - process.hrtime.bigint();
			if (left > 0n) arm(msCeil(left));
			else callback();
		};
		arm(Math.max(0, Math.ceil(delayMs)));
		return Object.freeze({ cancel: () => clearTimeout(handle) });
	},
});

/** The wall-clock time and randomness invocation identities take (EM11). */
export const machineIdentities: IdentitySource = Object.freeze({
	wallTimeMs: (): number => Date.now(),
	randomHex: (digits: number): string => randomBytes(Math.ceil(digits / 2)).toString("hex").slice(0, digits),
});
