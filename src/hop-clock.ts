/**
 * The clock both halves read (CONTRACT.md, PX5, PX7): a monotonic reading in nanoseconds - on a machine,
 * Linux's CLOCK_MONOTONIC as Node's `process.hrtime.bigint()` gives it, one clock for every process of the
 * machine, which a change to the wall clock does not move - and a way to be called back after a delay.
 *
 * A timer's waking is not the deadline (zorg's target, EM12; operation-call's stage 4 finding): every
 * deadline here is a moment on the clock, and on each wakeup the clock is read and, while the moment has
 * not come, the timer is set again for the time remaining. The call layer's own clock port is given a view
 * of the same clock in milliseconds, so the proxy's call is bound on the clock the deadline crossed on.
 * Nothing here is particular to one runtime.
 */
import type { CallClock, ClockTimer } from "@apnex/operation-call";

/** A pending callback of a clock, which can be cancelled. */
export interface HopTimer {
	cancel(): void;
}

/** A monotonic clock in nanoseconds, and timers on it. */
export interface HopClock {
	/** Nanoseconds on a monotonic clock that a change to the wall clock does not move. */
	nowNs(): bigint;
	/**
	 * Calls `callback` once about `delayMs` milliseconds have passed; the wakeup may come early or late, so
	 * whoever arms it reads the clock again when it runs.
	 */
	schedule(delayMs: number, callback: () => void): HopTimer;
}

/** Nanoseconds in a millisecond. */
export const NS_PER_MS = 1_000_000n;

/** A duration in nanoseconds as whole milliseconds, rounded up, for a timer's delay. */
export function msCeil(ns: bigint): number {
	return ns <= 0n ? 0 : Number((ns + NS_PER_MS - 1n) / NS_PER_MS);
}

/** Whole milliseconds as nanoseconds. */
export function msToNs(ms: number): bigint {
	return BigInt(ms) * NS_PER_MS;
}

/**
 * Calls `callback` once the clock reads `deadlineNs` or later, never sooner: each wakeup reads the clock and,
 * while the deadline has not come, arms the timer again for the time remaining (EM12's lesson). A clock that
 * can no longer be read or schedule at a wakeup is a fault of the port and leaves nothing to wait on, so the
 * timer's word is taken that the moment has come, as the call layer's caller takes it (EM12); nothing thrown
 * by the port escapes into the runtime's timer.
 */
export function atMoment(clock: HopClock, deadlineNs: bigint, callback: () => void): HopTimer {
	let done = false;
	let timer: HopTimer | undefined;
	const wake = (): void => {
		if (done) return;
		try {
			const left = deadlineNs - clock.nowNs();
			if (left > 0n) {
				timer = clock.schedule(msCeil(left), wake);
				return;
			}
		} catch {
			// The port failed: the timer's word is taken.
		}
		done = true;
		callback();
	};
	timer = clock.schedule(msCeil(deadlineNs - clock.nowNs()), wake);
	return Object.freeze({
		cancel(): void {
			done = true;
			timer?.cancel();
		},
	});
}

/** The call layer's clock port over a hop clock, whose next reading can be pinned to a reading already taken. */
export interface PinnableCallClock extends CallClock {
	/**
	 * Makes the next reading of this port give the moment `ns` was read, so a call the proxy makes at once
	 * starts its bound at the very reading the proxy took its bound from (PX5); `unpin` clears it.
	 */
	pin(ns: bigint): void;
	unpin(): void;
}

/**
 * The call layer's clock port (EM12) over a hop clock: milliseconds from the moment the port was made, and
 * the hop clock's timers, which the call layer re-arms itself on every wakeup.
 */
export function callClockOf(clock: HopClock): PinnableCallClock {
	const origin = clock.nowNs();
	let pinned: bigint | undefined;
	const ms = (ns: bigint): number => Number(ns - origin) / 1e6;
	return Object.freeze({
		now(): number {
			if (pinned !== undefined) {
				const reading = pinned;
				pinned = undefined;
				return ms(reading);
			}
			return ms(clock.nowNs());
		},
		schedule(delayMs: number, callback: () => void): ClockTimer {
			return clock.schedule(delayMs, callback);
		},
		pin(ns: bigint): void {
			pinned = ns;
		},
		unpin(): void {
			pinned = undefined;
		},
	});
}
