/**
 * The proxy half (CONTRACT.md, PX4, PX5, PX6, PX7): run in the proxy, holding the one caller of the call
 * layer the application builds from the key, and carrying every connection's invocations through it.
 *
 * A connection sends `hello` first; a version other than 1, or a key other than the proxy's own, is answered
 * `refused` and closed; any other key is welcomed once the caller is ready by the application's own test, and
 * not before. A welcomed connection carries any number of invocations at once, paired by `request`. The proxy
 * hands each invocation to its caller as it arrives, keeping no backlog: addressed to `<service>/<operation>`
 * on its host, under its invocation identity and repeat flag, with a bound of `deadline` less the proxy's own
 * reading of the clock, rounded down to a whole millisecond and at most 2147483647, and an abort signal already
 * fired when `aborted` is true, which `abort` fires. With less than 1 millisecond left it hands nothing on and
 * answers `not-delivered` with `deadline-passed`. The call's bound starts at the very reading it was computed
 * from. A line that breaks the table closes the connection; when a connection goes, its calls are finished and
 * their endings dropped, and nothing is ever repeated.
 *
 * The proxy is idle while no connection is open and no call is in flight; its idle timer starts when it
 * becomes idle and is cancelled when it stops being idle, and when it fires the proxy checks again - a turn
 * of its clock later, so a connection waiting to be accepted is counted - and stays if a connection is open or
 * a call is in flight (PX7).
 *
 * An invocation written with `parts` true (zorg's Delta 4, stage 6; D64) is handed on with an `onPart` that
 * writes each part its call gives as a `part`, at once and in order, and the proxy writes an `alive` for it
 * whenever the greater of 1 millisecond and half its call's bound has passed since it handed the invocation on
 * or last wrote a `part` or an `alive`, until the call's ending is sent or dropped or the connection closes
 * (PX5). When a connection closes, the abort signal of each invocation in parts it carried fires, so its call is
 * cancelled rather than left running (PX6). Once told to stop taking invocations, it answers each `invoke`
 * `not-delivered` with `proxy-stopping` and fires the abort signal of each invocation in parts in flight (PX7).
 * Nothing here is particular to one runtime.
 */
import { MAX_BOUND_MS, type CallLayerEnding, type CallRequest, type JsonValue } from "@apnex/operation-call";
import { observePromises, readPlainJson } from "@apnex/shape-check";
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { isOtherVersion, readHello, readInvokeOrAbort, writeAliveMessage, writeEnd, writePartMessage, writeRefused, writeWelcome, type InvokeMessage } from "./channel-messages.js";
import { hasExactly, isObject, proxyNotDelivered, readCarriedEnding, type CarriedEnding } from "./endings.js";
import { atMoment, msToNs, NS_PER_MS, type HopClock, type HopTimer, type PinnableCallClock } from "./hop-clock.js";
import { checkKey, sameKey, type ProxyKey } from "./key.js";

/** The shortest and longest idle time an application may state, in milliseconds (PX7). */
export const IDLE_LIMITS_MS = Object.freeze({ min: 1000, max: 86_400_000 });

/** Checks an idle time (PX7): a whole number of milliseconds from 1 second to 24 hours. */
export function checkIdleTime(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < IDLE_LIMITS_MS.min || (value as number) > IDLE_LIMITS_MS.max) {
		throw new RangeError("an idle time is a whole number of milliseconds from 1000 (1 second) to 86400000 (24 hours)");
	}
	return value as number;
}

/**
 * The proxy's caller: the call layer's own, giving only the call layer's endings (EM12), which an `end` carries
 * (PX4). operation-call's caller is one.
 */
export interface CallLayerCaller {
	invoke(call: CallRequest): Promise<CallLayerEnding>;
}

/** What a proxy half is built from. */
export interface ProxyHalfOptions {
	/** The one key the proxy serves (PX1). */
	readonly key: ProxyKey;
	/** The clock `deadline` crossed on; on a machine, CLOCK_MONOTONIC. */
	readonly clock: HopClock;
	/** The application's idle time, from 1 second to 24 hours (PX7, PX9). */
	readonly idleMs: number;
	/** Called once, when the idle timer fires and the proxy is still idle; the host then stops it. */
	readonly onIdle: () => void;
}

/** The proxy half. */
export interface ProxyHalf {
	/** Takes a new connection of the channel, giving the handlers its link reports to. */
	accept(link: ChannelLink): LinkHandlers;
	/**
	 * The application's caller is ready by its own test (PX9): every connection waiting is welcomed, and each
	 * call is made through this caller, whose clock port is `callClock`.
	 */
	ready(caller: CallLayerCaller, callClock: PinnableCallClock): void;
	/** How many connections are open. */
	connections(): number;
	/** How many calls are in flight: handed to the caller, their endings not yet sent or dropped. */
	inFlight(): number;
	/** Resolves once no call is in flight, each call's ending sent or dropped. */
	drained(): Promise<void>;
	/** Stops the idle timer, for a proxy that is stopping. */
	stopIdle(): void;
	/**
	 * Takes no more invocations: each `invoke` read from now on is answered `not-delivered` with `proxy-stopping`,
	 * and the abort signal of each invocation in parts in flight fires, so its call ends within its bound (PX7).
	 */
	stopInvocations(): void;
	/** Closes every connection not yet welcomed. */
	closeUnwelcomed(): void;
	/** Closes every connection. */
	closeAll(): void;
}

/** One connection, as the proxy half sees it. */
interface Conn {
	readonly link: ChannelLink;
	state: "hello" | "waiting" | "welcomed" | "closed";
	/** Every request number this connection has used, so a number used twice breaks the table. */
	readonly used: Set<number>;
	/** Each of its calls in flight. */
	readonly calls: Map<number, Carried>;
}

/** A call in flight, as the proxy half carries it. */
interface Carried {
	readonly controller: AbortController;
	/** True when its invocation was written with `parts` true. */
	readonly parts: boolean;
	/** Stops its `alive`, once its ending is sent or dropped or its connection has closed (PX5). */
	readonly quiet: () => void;
}

/** Runs one step on its own: a step that throws changes nothing already decided, nor any step after it. */
function guarded(step: () => void): void {
	try {
		step();
	} catch {
		// What the step left behind finds its call finished.
	}
}

/** Builds a proxy half. */
export function createProxyHalf(options: ProxyHalfOptions): ProxyHalf {
	const key = checkKey(options.key);
	const idleMs = checkIdleTime(options.idleMs);
	const { clock, onIdle } = options;
	const conns = new Set<Conn>();
	let caller: CallLayerCaller | undefined;
	let callClock: PinnableCallClock | undefined;
	let inFlight = 0;
	let idleTimer: HopTimer | undefined;
	let idleStopped = false;
	let idleEnded = false;
	let stoppingInvocations = false;
	let drainWaiters: (() => void)[] = [];

	const idle = (): boolean => conns.size === 0 && inFlight === 0;
	/** Starts the idle timer when the proxy becomes idle, and cancels it when it stops being idle. */
	const reviewIdle = (): void => {
		if (idleStopped || idleEnded) return;
		if (!idle()) {
			idleTimer?.cancel();
			idleTimer = undefined;
			return;
		}
		if (idleTimer !== undefined) return;
		idleTimer = atMoment(clock, clock.nowNs() + msToNs(idleMs), () => {
			// It checks again when it fires, and stays if a connection is open or a call is in flight. The check
			// is made a turn later, so a connection already waiting to be accepted as the timer fires is counted.
			idleTimer = clock.schedule(0, () => {
				idleTimer = undefined;
				if (idleStopped || idleEnded || !idle()) return;
				idleEnded = true;
				onIdle();
			});
		});
	};

	const callEnded = (): void => {
		inFlight--;
		if (inFlight === 0) {
			const waiters = drainWaiters;
			drainWaiters = [];
			for (const resolve of waiters) resolve();
		}
		reviewIdle();
	};

	const send = (conn: Conn, request: number, ending: CarriedEnding): void => {
		if (conn.state !== "closed") conn.link.write(writeEnd(request, ending));
	};

	/**
	 * The `onPart` an invocation in parts is handed on with, and its `alive` (PX5): each part its call gives - read as
	 * plain data, `{sequence, answer}` with the next `sequence` - is written at once as a `part`; and an `alive` is
	 * written whenever `every` has passed on the clock since `from` or since the last `part` or `alive` written, a
	 * timer that wakes late writing one and counting on from it, until `quiet` is called.
	 */
	const signsOfLife = (conn: Conn, request: number, from: bigint, every: bigint): { readonly onPart: (part: unknown) => void; readonly quiet: () => void } => {
		let quieted = false;
		let last = from;
		let next = 1;
		let timer: HopTimer | undefined;
		const written = (): void => {
			try {
				last = clock.nowNs();
			} catch {
				// The next alive counts on from the last time known.
			}
		};
		const arm = (): void => {
			try {
				timer = atMoment(clock, last + every, due);
			} catch {
				// A clock that cannot set a timer writes no more alive; the client half's deadline tells it.
			}
		};
		const due = (): void => {
			if (quieted || conn.state === "closed") return;
			let now: bigint;
			try {
				now = clock.nowNs();
			} catch {
				now = last + every;
			}
			if (now - last >= every) {
				last = now;
				conn.link.write(writeAliveMessage(request));
			}
			arm();
		};
		arm();
		return {
			onPart(part: unknown): void {
				if (quieted || conn.state === "closed") return;
				const plain = readPlainJson(part);
				if (!plain.ok || !isObject(plain.value) || !hasExactly(plain.value, ["sequence", "answer"]) || plain.value.sequence !== next) return;
				next++;
				conn.link.write(writePartMessage(request, plain.value.sequence as number, plain.value.answer as JsonValue));
				written();
			},
			quiet(): void {
				quieted = true;
				guarded(() => timer?.cancel());
			},
		};
	};

	/** Hands an invocation to the caller as it arrives (PX5). */
	const handOn = (conn: Conn, invoke: InvokeMessage): void => {
		if (stoppingInvocations) {
			send(conn, invoke.request, proxyNotDelivered("proxy-stopping", invoke.invocation, invoke.operation, invoke.repeat));
			return;
		}
		const now = clock.nowNs();
		const left = BigInt(invoke.deadline) - now;
		if (left < NS_PER_MS || caller === undefined || callClock === undefined) {
			send(conn, invoke.request, proxyNotDelivered("deadline-passed", invoke.invocation, invoke.operation, invoke.repeat));
			return;
		}
		const bound = Number(left / NS_PER_MS > BigInt(MAX_BOUND_MS) ? BigInt(MAX_BOUND_MS) : left / NS_PER_MS);
		const controller = new AbortController();
		if (invoke.aborted) controller.abort();
		const signs = invoke.parts ? signsOfLife(conn, invoke.request, now, msToNs(Math.max(1, Math.floor(bound / 2)))) : undefined;
		conn.calls.set(invoke.request, { controller, parts: invoke.parts, quiet: () => signs?.quiet() });
		inFlight++;
		reviewIdle();
		const finishCall = (settledValue?: unknown, haveValue = false): void => {
			signs?.quiet();
			try {
				if (haveValue) {
					// Read the caller's ending as plain data through readCarriedEnding (PX6, PX9; D54, D55).
					// A deadline-passed ending has attempt null and is the proxy's own, not the call layer's.
					const checked = readCarriedEnding(settledValue, invoke.invocation, invoke.operation);
					if (checked !== undefined && checked.attempt !== null) send(conn, invoke.request, checked);
				}
			} finally {
				conn.calls.delete(invoke.request);
				callEnded();
			}
		};
		let raw: unknown;
		// The call's bound starts at the reading it was computed from, so its deadline is never later than `deadline`.
		callClock.pin(now);
		try {
			raw = caller.invoke({
				host: invoke.host, service: invoke.service, operation: invoke.operation, input: invoke.input,
				bound, invocation: invoke.invocation, repeat: invoke.repeat, signal: controller.signal,
				...(signs === undefined ? {} : { onPart: signs.onPart }),
			});
		} catch (error) {
			observePromises(error);
			finishCall();
			return;
		} finally {
			callClock.unpin();
		}
		let native = false;
		try {
			native = raw instanceof Promise;
		} catch (error) {
			observePromises(error);
			observePromises(raw);
			finishCall();
			return;
		}
		if (!native) {
			// A non-native thenable is not awaited (D54, D55); readCarriedEnding checks plain data and observes promises.
			finishCall(raw, true);
			return;
		}
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => finishCall(value, true),
				(error: unknown) => {
					observePromises(error);
					finishCall();
				},
			]);
		} catch (error) {
			observePromises(error);
			observePromises(raw);
			finishCall();
		}
	};

	const close = (conn: Conn): void => {
		conn.link.close();
	};

	const message = (conn: Conn, value: unknown): void => {
		switch (conn.state) {
			case "closed":
				return;
			case "hello": {
				if (isOtherVersion(value)) {
					conn.link.write(writeRefused("version"));
					return close(conn);
				}
				const hello = readHello(value);
				if (hello === undefined) return close(conn);
				if (!sameKey(hello.key, key)) {
					conn.link.write(writeRefused("key-mismatch"));
					return close(conn);
				}
				if (caller === undefined) {
					conn.state = "waiting";
					return;
				}
				conn.state = "welcomed";
				conn.link.write(writeWelcome());
				return;
			}
			case "waiting":
				// The client sends nothing after `hello` until `welcome`.
				return close(conn);
			case "welcomed": {
				const read = readInvokeOrAbort(value);
				if (read === undefined) return close(conn);
				if (read.type === "abort") {
					// An abort for a request already ended, or never invoked, is ignored.
					conn.calls.get(read.request)?.controller.abort();
					return;
				}
				if (conn.used.has(read.request)) return close(conn);
				conn.used.add(read.request);
				return handOn(conn, read);
			}
		}
	};

	const half: ProxyHalf = Object.freeze({
		accept(link: ChannelLink): LinkHandlers {
			const conn: Conn = { link, state: "hello", used: new Set(), calls: new Map() };
			conns.add(conn);
			reviewIdle();
			return {
				message: (value: unknown) => message(conn, value),
				closed: () => {
					if (conn.state === "closed") return;
					conn.state = "closed";
					conns.delete(conn);
					// Its calls are finished by the call layer, and their endings dropped; nothing is repeated. Each
					// invocation in parts is cancelled rather than left running (PX6).
					for (const carried of [...conn.calls.values()]) {
						guarded(carried.quiet);
						if (carried.parts) guarded(() => carried.controller.abort());
					}
					reviewIdle();
				},
			};
		},
		ready(readyCaller: CallLayerCaller, readyClock: PinnableCallClock): void {
			if (caller !== undefined) return;
			caller = readyCaller;
			callClock = readyClock;
			for (const conn of conns) {
				if (conn.state !== "waiting") continue;
				conn.state = "welcomed";
				conn.link.write(writeWelcome());
			}
		},
		connections: () => conns.size,
		inFlight: () => inFlight,
		drained: () => inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => { drainWaiters.push(resolve); }),
		stopIdle(): void {
			idleStopped = true;
			idleTimer?.cancel();
			idleTimer = undefined;
		},
		stopInvocations(): void {
			stoppingInvocations = true;
			for (const conn of [...conns]) {
				for (const carried of [...conn.calls.values()]) if (carried.parts) guarded(() => carried.controller.abort());
			}
		},
		closeUnwelcomed(): void {
			for (const conn of [...conns]) if (conn.state === "hello" || conn.state === "waiting") close(conn);
		},
		closeAll(): void {
			for (const conn of [...conns]) close(conn);
		},
	});
	// A proxy starts idle, with no connection open and no call in flight.
	reviewIdle();
	return half;
}
