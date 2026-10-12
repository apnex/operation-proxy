// manual-hop-clock - the hop's clock under test control (CONTRACT.md, PX5, PX7; zorg's target, EM12): a
// monotonic reading in nanoseconds that moves only when a test moves it, and timers on it.
//
// `advance(ms)` moves the reading forward, running every callback due by then in the order it falls due, the
// reading set to each one's due moment as it runs; `move(ms)` moves the reading alone, running nothing, as a
// runtime does whose timer callbacks are delayed behind other work; the next `advance`, of 0 or more, runs
// what fell due. Milliseconds may be fractional, kept to the nanosecond. `earlyMs` makes every timer wake that
// much before its delay has passed, but no sooner than halfway through it, as a runtime's timer can wake
// against the clock it reads.

/** Whole nanoseconds of a duration in milliseconds, which may be fractional. */
export const ns = (ms) => BigInt(Math.round(ms * 1e6));

export function createManualHopClock({ start = 1_000_000_000_000n, earlyMs = 0 } = {}) {
	let now = start;
	let nextId = 1;
	const tasks = [];
	const delays = [];
	return {
		delays,
		nowNs: () => now,
		/** The reading in milliseconds since the clock's start, for messages. */
		elapsedMs: () => Number(now - start) / 1e6,
		start,
		schedule(delayMs, callback) {
			if (!Number.isFinite(delayMs) || delayMs < 0) throw new RangeError(`a delay of ${delayMs} ms`);
			delays.push(delayMs);
			const task = { id: nextId++, due: now + ns(Math.max(delayMs - earlyMs, delayMs / 2)), callback, cancelled: false };
			tasks.push(task);
			return { cancel() { task.cancelled = true; } };
		},
		advance(ms) {
			if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`an advance of ${ms} ms`);
			const target = now + ns(ms);
			for (;;) {
				let due;
				for (const t of tasks) if (!t.cancelled && t.due <= target && (due === undefined || t.due < due.due || (t.due === due.due && t.id < due.id))) due = t;
				if (due === undefined) break;
				if (due.due > now) now = due.due;
				due.cancelled = true;
				due.callback();
			}
			now = target;
			for (let i = tasks.length - 1; i >= 0; i--) if (tasks[i].cancelled) tasks.splice(i, 1);
		},
		move(ms) {
			if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`a move of ${ms} ms`);
			now += ns(ms);
		},
		pending: () => tasks.filter((t) => !t.cancelled).length,
	};
}
