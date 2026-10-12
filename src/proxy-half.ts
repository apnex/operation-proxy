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
 * a call is in flight (PX7). Nothing here is particular to one runtime.
 */
import type { CallLayerEnding, CallRequest } from "@apnex/operation-call";
import { MAX_BOUND_MS } from "./call-checks.js";
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { isOtherVersion, readHello, readInvokeOrAbort, writeEnd, writeRefused, writeWelcome, type InvokeMessage } from "./channel-messages.js";
import { proxyNotDelivered, type CarriedEnding } from "./endings.js";
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
	/** The abort controller of each of its calls in flight. */
	readonly calls: Map<number, AbortController>;
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

	/** Hands an invocation to the caller as it arrives (PX5). */
	const handOn = (conn: Conn, invoke: InvokeMessage): void => {
		const now = clock.nowNs();
		const left = BigInt(invoke.deadline) - now;
		if (left < NS_PER_MS || caller === undefined || callClock === undefined) {
			send(conn, invoke.request, proxyNotDelivered("deadline-passed", invoke.invocation, invoke.operation, invoke.repeat));
			return;
		}
		const bound = Number(left / NS_PER_MS > BigInt(MAX_BOUND_MS) ? BigInt(MAX_BOUND_MS) : left / NS_PER_MS);
		const controller = new AbortController();
		if (invoke.aborted) controller.abort();
		conn.calls.set(invoke.request, controller);
		inFlight++;
		reviewIdle();
		let ending: Promise<CallLayerEnding>;
		// The call's bound starts at the reading it was computed from, so its deadline is never later than `deadline`.
		callClock.pin(now);
		try {
			ending = caller.invoke({
				host: invoke.host, service: invoke.service, operation: invoke.operation, input: invoke.input,
				bound, invocation: invoke.invocation, repeat: invoke.repeat, signal: controller.signal,
			});
		} catch (error) {
			ending = Promise.reject(error);
		} finally {
			callClock.unpin();
		}
		Promise.resolve(ending).then((value) => send(conn, invoke.request, value), () => {
			// A caller that rejects gives no ending to carry; the client half's deadline decides, as hop-stalled.
		}).finally(() => {
			conn.calls.delete(invoke.request);
			callEnded();
		}).catch(() => undefined);
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
					conn.calls.get(read.request)?.abort();
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
					// Its calls are finished by the call layer, and their endings dropped; nothing is repeated.
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
