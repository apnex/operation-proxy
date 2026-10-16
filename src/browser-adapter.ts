/**
 * The browser adapter (CONTRACT.md, PX1, PX4 to PX6, PX8, PX9; zorg's D31, D46, D48, D57, D58): the client
 * half in a browser page reaching a SharedWorker named `operation-proxy:<digest>` over one MessagePort per
 * page, and the proxy half in the SharedWorker carrying every page's invocations through its one caller.
 *
 * A page and a worker share no clock, so `deadline` on an `invoke` message is the milliseconds remaining until
 * PX5's sooner deadline at the moment the page posts the message, by the page's clock; a message whose
 * remaining time at posting is 1 millisecond or more (`Math.floor(remainingMs) >= 1`) is admitted however late
 * it arrives and bound by `Math.floor(remainingMs)` milliseconds from its receipt on the worker's clock, while
 * one with less than 1 millisecond left at posting is refused `deadline-passed`.
 *
 * Because a MessagePort reports no closing, each side sends `{"operationProxy": 1, "type": "ping"}` every
 * 5 seconds from the moment the port connects (before and after `welcome`) and treats a peer silent for
 * 15 seconds as gone, the page then ending its written invocations `unknown` with `proxy-lost`.
 * Nothing here imports a Node module or uses a Node global (principle 6).
 */
import type { CallClock, IdentitySource } from "@apnex/operation-call";
import { observePromises, readPlainJson } from "@apnex/shape-check";
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { CHANNEL_VERSION, type ChannelMessage } from "./channel-messages.js";
import { allowanceFor, checkHopAllowance, createProxyClient, DEFAULT_HOP_ALLOWANCE_MS, type ProxyClient } from "./client-half.js";
import { atMoment, callClockOf, msToNs, NS_PER_MS, type HopClock, type HopTimer, type PinnableCallClock } from "./hop-clock.js";
import { checkKey, keyDigest, type ProxyKey } from "./key.js";
import { createProxyHalf, type CallLayerCaller, type ProxyHalf } from "./proxy-half.js";

/** How often each side of a browser port sends a `ping`, in milliseconds (PX8). */
export const BROWSER_PING_INTERVAL_MS = 5_000;
/** How long a side waits without hearing from the other before treating the port as gone, in milliseconds (PX8). */
export const BROWSER_LIVENESS_TIMEOUT_MS = 15_000;

/** A `ping` message carried only by the browser adapter (PX8). */
export interface PingMessage {
	readonly operationProxy: 1;
	readonly type: "ping";
}

/** The surface of a browser `MessagePort` used by the adapter. */
export interface BrowserMessagePort {
	postMessage(message: unknown): void;
	addEventListener?(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	removeEventListener?(type: "message", listener: (event: { readonly data: unknown }) => void): void;
	onmessage?: ((event: { readonly data: unknown }) => void) | null;
	start?(): void;
	close?(): void;
}

/** The surface of a `SharedWorker` global scope where `runBrowserProxy` accepts page connections. */
export interface BrowserWorkerScope {
	onconnect?: ((event: { readonly ports: readonly BrowserMessagePort[] }) => void) | null;
	addEventListener?(type: "connect", listener: (event: { readonly ports: readonly BrowserMessagePort[] }) => void): void;
}

/** What an application supplies to the client half in a browser page (PX8, PX9). */
export interface BrowserClientApplication {
	readonly key: ProxyKey;
	/** The URL of the worker script, passed to `SharedWorker` with name `operation-proxy:<digest>`. */
	readonly workerUrl: string;
	/** The hop allowance: a whole number of milliseconds from 0 to 1000, by default 50. */
	readonly hopAllowanceMs?: number;
}

/** Ports for a client half in a browser page. */
export interface BrowserClientOptions {
	/** The page's monotonic clock; `performance.now()` by default. */
	readonly clock?: HopClock;
	/** Where invocation identities take their wall-clock time and randomness from. */
	readonly identities?: IdentitySource;
	/** Opens a `MessagePort` to the named `SharedWorker`; `new SharedWorker(workerUrl, { name }).port` by default. */
	readonly openPort?: (workerUrl: string, name: string) => BrowserMessagePort | Promise<BrowserMessagePort>;
}

/** The proxy's caller in a browser worker (PX1, PX8, PX9). */
export interface BrowserProxiedCaller {
	readonly caller: CallLayerCaller;
	stop?(): Promise<void> | void;
}

/** What an application supplies to its proxy in a browser `SharedWorker` (PX8, PX9). */
export interface BrowserProxyApplication {
	readonly key: ProxyKey;
	buildCaller(key: ProxyKey, ports: { readonly clock: CallClock }): Promise<BrowserProxiedCaller> | BrowserProxiedCaller;
	callerReady(built: BrowserProxiedCaller): Promise<void> | void;
}

/** Ports for a proxy running in a browser `SharedWorker`. */
export interface BrowserProxyOptions {
	/** The worker's monotonic clock; `performance.now()` by default. */
	readonly clock?: HopClock;
	/** The worker global scope; `globalThis` by default. */
	readonly scope?: BrowserWorkerScope;
}

/** A running browser proxy in a `SharedWorker`. */
export interface BrowserProxy {
	/** The `SharedWorker` name `operation-proxy:<digest>`. */
	readonly name: string;
	/** Connects a page's `MessagePort` directly. */
	connectPort(port: BrowserMessagePort): void;
	/** Resolves once `buildCaller` and `callerReady` have completed, or `false` if startup failed. */
	readonly ready: Promise<boolean>;
	/** Closes all open ports and stops heartbeats. */
	close(): void;
}

/** The `SharedWorker` name for a key's digest: `operation-proxy:<digest>` (PX8). */
export function browserWorkerName(digest: string): string {
	return `operation-proxy:${digest}`;
}

/** Default monotonic clock in a browser environment using `performance.now()`. */
export const defaultBrowserClock: HopClock = Object.freeze({
	nowNs: () => msToNs(globalThis.performance.now()),
	schedule(delayMs: number, callback: () => void): HopTimer {
		const handle = globalThis.setTimeout(callback, Math.max(0, Math.ceil(delayMs)));
		return { cancel: () => globalThis.clearTimeout(handle) };
	},
});

/** Default identity source in a browser environment using `Date.now()` and `crypto.getRandomValues`. */
export const defaultBrowserIdentities: IdentitySource = Object.freeze({
	wallTimeMs: () => globalThis.Date.now(),
	randomHex(digits: number): string {
		const bytes = new Uint8Array(Math.ceil(digits / 2));
		globalThis.crypto.getRandomValues(bytes);
		let out = "";
		for (const b of bytes) out += b.toString(16).padStart(2, "0");
		return out.slice(0, digits);
	},
});

/** True when a plain JSON value is `{"operationProxy": 1, "type": "ping"}` with no extra fields. */
function isPing(value: unknown): value is PingMessage {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const rec = value as { readonly [k: string]: unknown };
	const keys = Object.keys(rec);
	return keys.length === 2 && rec.operationProxy === CHANNEL_VERSION && rec.type === "ping";
}

/**
 * Wraps a `BrowserMessagePort` as a `ChannelLink` with 5-second `ping` heartbeats and a 15-second liveness
 * bound on `clock`, starting immediately upon connection (before and after `welcome`, PX8, D58).
 * `transformOutgoing` and `transformIncoming` convert `invoke.deadline` between the client half's absolute
 * nanosecond deadline on the page's clock and the relative milliseconds carried on the message port.
 */
function portChannelLink(
	port: BrowserMessagePort,
	clock: HopClock,
	handlers: LinkHandlers,
	transformOutgoing: (msg: ChannelMessage) => unknown,
	transformIncoming: (msg: { readonly [k: string]: unknown }) => unknown,
): ChannelLink {
	let open = true;
	let pingTimer: HopTimer | undefined;
	let livenessTimer: HopTimer | undefined;
	let lastHeardAt = clock.nowNs();

	const stopTimers = (): void => {
		try { pingTimer?.cancel(); } catch { /* ignore */ }
		try { livenessTimer?.cancel(); } catch { /* ignore */ }
		pingTimer = undefined;
		livenessTimer = undefined;
	};

	const closeLink = (): void => {
		if (!open) return;
		open = false;
		stopTimers();
		if (typeof port.removeEventListener === "function") {
			try { port.removeEventListener("message", onEvent); } catch { /* ignore */ }
		} else if (port.onmessage === onEvent) {
			port.onmessage = null;
		}
		try { port.close?.(); } catch { /* ignore */ }
		handlers.closed();
	};

	const armPing = (): void => {
		if (!open) return;
		const nextPingAt = clock.nowNs() + msToNs(BROWSER_PING_INTERVAL_MS);
		pingTimer = atMoment(clock, nextPingAt, () => {
			if (!open) return;
			try {
				port.postMessage({ operationProxy: CHANNEL_VERSION, type: "ping" });
			} catch {
				closeLink();
				return;
			}
			armPing();
		});
	};

	const armLiveness = (): void => {
		if (!open) return;
		try { livenessTimer?.cancel(); } catch { /* ignore */ }
		const deadline = lastHeardAt + msToNs(BROWSER_LIVENESS_TIMEOUT_MS);
		livenessTimer = atMoment(clock, deadline, () => {
			if (!open) return;
			if (clock.nowNs() >= lastHeardAt + msToNs(BROWSER_LIVENESS_TIMEOUT_MS)) {
				closeLink();
				return;
			}
			armLiveness();
		});
	};

	const onEvent = (event: { readonly data: unknown }): void => {
		if (!open) return;
		const plain = readPlainJson(event?.data);
		if (!plain.ok || plain.value === null || typeof plain.value !== "object" || Array.isArray(plain.value)) {
			closeLink();
			return;
		}
		lastHeardAt = clock.nowNs();
		armLiveness();
		if (isPing(plain.value)) return;
		const transformed = transformIncoming(plain.value as { readonly [k: string]: unknown });
		if (transformed === undefined) {
			closeLink();
			return;
		}
		handlers.message(transformed);
	};

	if (typeof port.addEventListener === "function") {
		port.addEventListener("message", onEvent);
	} else {
		port.onmessage = onEvent;
	}
	port.start?.();
	armPing();
	armLiveness();

	return {
		write(message: ChannelMessage): boolean {
			if (!open) return false;
			try {
				port.postMessage(transformOutgoing(message));
				return true;
			} catch {
				closeLink();
				return false;
			}
		},
		hold(): void {
			// A browser page has no process reference count to hold.
		},
		close: closeLink,
	};
}

/** Builds a client half in a browser page reaching its `SharedWorker` (PX8). */
export function createBrowserClient(application: BrowserClientApplication, options: BrowserClientOptions = {}): ProxyClient {
	if (application === null || typeof application !== "object") throw new TypeError("a browser client needs { key, workerUrl, hopAllowanceMs }");
	const key = checkKey(application.key);
	if (typeof application.workerUrl !== "string" || application.workerUrl.length === 0) throw new TypeError("a browser client needs a non-empty workerUrl string");
	const hopAllowanceMs = checkHopAllowance(application.hopAllowanceMs === undefined ? DEFAULT_HOP_ALLOWANCE_MS : application.hopAllowanceMs);
	const clock = options.clock ?? defaultBrowserClock;
	const identities = options.identities ?? defaultBrowserIdentities;
	const digest = keyDigest(key);
	const name = browserWorkerName(digest);
	const openPort = options.openPort ?? ((workerUrl: string, workerName: string): BrowserMessagePort => {
		const SharedWorkerCtor = (globalThis as unknown as { SharedWorker?: new (u: string, o: { name: string }) => { port: BrowserMessagePort } }).SharedWorker;
		if (typeof SharedWorkerCtor !== "function") throw new Error("SharedWorker is not available in this runtime");
		const worker = new SharedWorkerCtor(workerUrl, { name: workerName });
		worker.port.start?.();
		return worker.port;
	});

	return createProxyClient({
		key,
		hopAllowanceMs,
		clock,
		identities,
		connector: {
			async connect(handlers: LinkHandlers) {
				const port = await openPort(application.workerUrl, name);
				const link = portChannelLink(
					port,
					clock,
					handlers,
					(message: ChannelMessage) => {
						if (message.type !== "invoke") return message;
						// Convert the client half's absolute nanosecond sooner deadline on the page's clock into the
						// relative milliseconds remaining at the moment of posting (PX8).
						const postAtNs = clock.nowNs();
						const soonerNs = BigInt(message.deadline);
						const remainingMs = Number(soonerNs - postAtNs) / 1e6;
						return { ...message, deadline: remainingMs };
					},
					(incoming) => incoming,
				);
				return { kind: "connected", link };
			},
			launch(): void {
				// The browser starts the SharedWorker when openPort constructs it (PX8).
			},
		},
	});
}

/** Awaits `fn()` only when it returns a native `Promise` (D54, D55), wrapping the settled value in `{ value }`. */
async function awaitNative(fn: () => unknown): Promise<{ readonly value: unknown }> {
	let raw: unknown;
	try {
		raw = fn();
	} catch (error) {
		observePromises(error);
		throw error;
	}
	let native = false;
	try {
		native = raw instanceof Promise;
	} catch (error) {
		observePromises(error);
		observePromises(raw);
		throw error;
	}
	if (!native) return { value: raw };
	try {
		return await (Reflect.apply(Promise.prototype.then, raw, [
			(resolved: unknown) => ({ value: resolved }),
			(error: unknown) => {
				observePromises(error);
				throw error;
			},
		]) as Promise<{ readonly value: unknown }>);
	} catch (error) {
		observePromises(error);
		observePromises(raw);
		throw error;
	}
}

/** Validates and copies a settled `buildCaller` result through its own enumerable data descriptors only (D54, D55). */
function validateBrowserCaller(candidate: unknown): BrowserProxiedCaller | undefined {
	const captured: unknown[] = [candidate];
	const fail = (): undefined => {
		for (const item of captured) observePromises(item);
		return undefined;
	};
	if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return fail();
	const readDesc = (obj: object, name: string): PropertyDescriptor | undefined => {
		const d = Object.getOwnPropertyDescriptor(obj, name);
		if (d !== undefined && Object.hasOwn(d, "value")) captured.push(d.value);
		return d;
	};
	try {
		interface Frame {
			readonly source: object;
			readonly copy: unknown[] | { [name: string]: unknown };
			readonly keys: readonly string[];
			readonly values: readonly unknown[];
			readonly forbidThen: boolean;
			next: number;
			readonly place: (finished: object) => void;
		}
		const readMembers = (obj: object, forbidThen: boolean): { readonly array: boolean; readonly keys: readonly string[]; readonly values: readonly unknown[] } | undefined => {
			if (obj instanceof Promise) return undefined;
			if (Object.getOwnPropertySymbols(obj).length > 0) return undefined;
			const proto = Object.getPrototypeOf(obj);
			const names = Object.getOwnPropertyNames(obj);
			if (Array.isArray(obj)) {
				if (proto !== Array.prototype) return undefined;
				const lenDesc = readDesc(obj, "length");
				if (lenDesc === undefined || !Object.hasOwn(lenDesc, "value") || typeof lenDesc.value !== "number" || !Number.isInteger(lenDesc.value) || lenDesc.value < 0 || names.length !== lenDesc.value + 1) return undefined;
				const keys: string[] = [];
				const values: unknown[] = [];
				for (let i = 0; i < lenDesc.value; i++) {
					const key = String(i);
					const d = readDesc(obj, key);
					if (d === undefined || d.enumerable !== true || !Object.hasOwn(d, "value")) return undefined;
					keys.push(key);
					values.push(d.value);
				}
				return { array: true, keys, values };
			}
			if (proto !== Object.prototype && proto !== null) return undefined;
			const values: unknown[] = [];
			for (const name of names) {
				if (forbidThen && name === "then") return undefined;
				const d = readDesc(obj, name);
				if (d === undefined || d.enumerable !== true || !Object.hasOwn(d, "value")) return undefined;
				values.push(d.value);
			}
			return { array: false, keys: names, values };
		};
		let rootCopy: { [name: string]: unknown } | undefined;
		const frames: Frame[] = [];
		const open = new Set<object>();
		const done = new Map<object, object>();
		const define = (target: object, key: string, value: unknown): void => {
			Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
		};
		const take = (item: unknown, forbidThen: boolean, place: (value: unknown) => void): boolean => {
			if (item === null || typeof item === "boolean" || typeof item === "string" || typeof item === "function") {
				place(item);
				return true;
			}
			if (typeof item === "number") {
				if (!Number.isFinite(item)) return false;
				place(item === 0 ? 0 : item);
				return true;
			}
			if (typeof item !== "object") return false;
			if (item instanceof Promise) return false;
			const existing = done.get(item);
			if (existing !== undefined) {
				place(existing);
				return true;
			}
			if (open.has(item)) return false;
			const members = readMembers(item, forbidThen);
			if (members === undefined) return false;
			const copy = members.array ? new Array<unknown>(members.keys.length) : {};
			open.add(item);
			frames.push({ source: item, copy, keys: members.keys, values: members.values, forbidThen, next: 0, place });
			return true;
		};
		if (!take(candidate, true, (v) => { rootCopy = v as { [name: string]: unknown }; })) return fail();
		while (frames.length > 0) {
			const frame = frames.at(-1) as Frame;
			if (frame.next < frame.keys.length) {
				const i = frame.next++;
				const key = frame.keys[i] as string;
				const val = frame.values[i];
				const childForbidThen = frame.source === candidate && key === "caller";
				if (childForbidThen && (val === null || typeof val !== "object" || Array.isArray(val))) return fail();
				if (!take(val, childForbidThen, (copied) => define(frame.copy, key, copied))) return fail();
				continue;
			}
			frames.pop();
			Object.freeze(frame.copy);
			open.delete(frame.source);
			done.set(frame.source, frame.copy);
			frame.place(frame.copy);
		}
		if (rootCopy === undefined) return fail();
		const callerVal = rootCopy.caller;
		const stopVal = rootCopy.stop;
		if (callerVal === null || typeof callerVal !== "object" || Array.isArray(callerVal)) return fail();
		if (stopVal !== undefined && typeof stopVal !== "function") return fail();
		const invokeVal = (callerVal as { readonly invoke?: unknown }).invoke;
		if (typeof invokeVal !== "function") return fail();
		return rootCopy as unknown as BrowserProxiedCaller;
	} catch (error) {
		captured.push(error);
		return fail();
	}
}

/** Runs a proxy in a browser `SharedWorker` (PX8). */
export function runBrowserProxy(application: BrowserProxyApplication, options: BrowserProxyOptions = {}): BrowserProxy {
	if (application === null || typeof application !== "object") throw new TypeError("a browser proxy needs { key, buildCaller, callerReady }");
	const key = checkKey(application.key);
	if (typeof application.buildCaller !== "function" || typeof application.callerReady !== "function") {
		throw new TypeError("an application supplies buildCaller and callerReady");
	}
	const clock = options.clock ?? defaultBrowserClock;
	const callClock: PinnableCallClock = callClockOf(clock);
	// In a browser, the browser starts the worker for the first page and ends it after the last, so there is no
	// idle timer (PX8); we pass the maximum idleMs and stop the proxy half's idle timer at once.
	const half: ProxyHalf = createProxyHalf({ key, clock, idleMs: 86_400_000, onIdle: () => undefined });
	half.stopIdle();
	const links = new Set<ChannelLink>();
	let failed = false;

	const connectPort = (port: BrowserMessagePort): void => {
		if (failed) {
			try { port.close?.(); } catch { /* ignore */ }
			return;
		}
		let handlers: LinkHandlers | undefined;
		const link = portChannelLink(
			port,
			clock,
			{
				message: (value) => handlers?.message(value),
				closed: () => {
					links.delete(link);
					handlers?.closed();
				},
			},
			(outgoing) => outgoing,
			(incoming) => {
				if (incoming.type !== "invoke") return incoming;
				// In the browser adapter (PX8), `deadline` on `invoke` is the remaining milliseconds at the moment
				// the page posted the message (a number or numeric string). A remaining time at posting of 1 whole
				// millisecond or more (`Math.floor(remainingMs) >= 1`) is admitted however late it arrives and bound
				// by `Math.floor(remainingMs)` milliseconds from its receipt on the worker's clock; one with less
				// than 1 millisecond is refused `deadline-passed`.
				const rawDeadline = incoming.deadline;
				const remainingMs = typeof rawDeadline === "number"
					? rawDeadline
					: typeof rawDeadline === "string" && rawDeadline.trim().length > 0
						? Number(rawDeadline)
						: Number.NaN;
				if (!Number.isFinite(remainingMs)) return undefined;
				const flooredMs = Math.floor(remainingMs);
				const nowNs = clock.nowNs();
				if (flooredMs < 1) {
					// Less than 1 whole millisecond at posting: pass a deadline < nowNs + NS_PER_MS so proxyHalf
					// answers `not-delivered` with `proxyCode: "deadline-passed"` without invoking the caller.
					return { ...incoming, deadline: nowNs >= NS_PER_MS ? (nowNs - NS_PER_MS).toString() : "0" };
				}
				const workerDeadlineNs = nowNs + msToNs(flooredMs);
				return { ...incoming, deadline: workerDeadlineNs.toString() };
			},
		);
		links.add(link);
		handlers = half.accept(link);
	};

	const scope = options.scope ?? (globalThis as unknown as BrowserWorkerScope);
	const onConnect = (event: { readonly ports: readonly BrowserMessagePort[] }): void => {
		for (const port of event?.ports ?? []) connectPort(port);
	};
	if (typeof scope?.addEventListener === "function") {
		scope.addEventListener("connect", onConnect);
	} else if (scope !== null && typeof scope === "object") {
		scope.onconnect = onConnect;
	}

	const ready = (async (): Promise<boolean> => {
		try {
			const { value: candidate } = await awaitNative(() => application.buildCaller(key, { clock: callClock }));
			const built = validateBrowserCaller(candidate);
			if (built === undefined) throw new TypeError("buildCaller must return a plain object with caller.invoke");
			const { value: readyValue } = await awaitNative(() => application.callerReady(built));
			if (readyValue !== undefined) {
				observePromises(readyValue);
				throw new TypeError("callerReady must settle to undefined");
			}
			if (failed) return false;
			half.ready(built.caller, callClock);
			return true;
		} catch (error) {
			observePromises(error);
			failed = true;
			for (const link of [...links]) link.close();
			half.closeAll();
			return false;
		}
	})();

	return Object.freeze({
		name: browserWorkerName(keyDigest(key)),
		connectPort,
		ready,
		close(): void {
			failed = true;
			for (const link of [...links]) link.close();
			half.closeAll();
		},
	});
}
