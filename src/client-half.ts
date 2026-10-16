/**
 * The client half (CONTRACT.md, PX1, PX5, PX6): the call layer's caller interface, run in each short-lived
 * process, carrying every invocation to the key's proxy and its ending back; and one step more, preparing.
 *
 * An invocation's bound starts when the caller invokes (EM12). The client half applies the call layer's own
 * checks on the caller's side first, so a programming error is thrown and a request the call layer would
 * refuse as `not-sendable` is refused so, with nothing written; it then reads its clock again, and a deadline
 * passed by then - at it exactly included - ends the invocation `unknown` with `bound-passed` and the attempt
 * identity it made, nothing written, as the call layer's caller does. It keeps its own deadline - the moment the
 * bound passes - and sends the proxy a sooner one, a hop allowance earlier: the application's allowance, by
 * default 50 milliseconds, or half the bound if that is less, rounded down to a whole millisecond (PX5).
 * When it is not prepared, preparing happens within the bound.
 *
 * The first of PX6's events decides the ending, and nothing after it changes it: no `welcome` by the deadline
 * with nothing written (`proxy-unreachable`); a `refused`; the invocation's `end`, unchanged; after any byte
 * of the `invoke` was written, the channel closing or carrying a malformed line (`unknown`, `proxy-lost`);
 * and the deadline passing before its `end` is read (`unknown`, `hop-stalled`). The deadline is a moment on
 * the clock: an event read at or after it is discarded, whichever runs first, the timer or the read. An
 * abort is relayed across the hop and changes the ending only as the call layer decides it, never here.
 * Endings of the client half's own checks come before these events, which follow those checks (PX6).
 *
 * A clock port that throws is a fault of the port (EM12): a reading that fails as an event is observed shows
 * nothing passed, so that event decides; a timer whose wakeup cannot read the clock takes its own word that
 * the deadline came; and settling resolves the chosen ending and releases its accounting before any step of
 * cleanup, each of which runs on its own, so a timer that cannot be cancelled changes nothing.
 * Nothing here is particular to one runtime (zorg's principle 6).
 */
import { readCallRequest, type CallRequest, type IdentitySource, type JsonValue, type OperationCaller, type RefusalRecord } from "@apnex/operation-call";
import { requestSendable, writeRequest } from "@apnex/operation-call/message-format";
import { toCanonicalJson, utf8ByteLength } from "@apnex/shape-check";
import { CHANNEL_LIMITS, writeInvoke } from "./channel-messages.js";
import { Preparer, type ClientConnector, type Connection, type Prepared, type Waiter, type WrittenInvocation } from "./client-preparing.js";
import { hopUnknown, preparingNotDelivered, proxyNotDelivered, type CarriedEnding, type PreparingEnding, type ProxiedEnding } from "./endings.js";
import { atMoment, msToNs, type HopClock, type HopTimer } from "./hop-clock.js";
import { checkKey, type ProxyKey } from "./key.js";

/** The hop allowance an application has unless it states its own (PX5, PX9). */
export const DEFAULT_HOP_ALLOWANCE_MS = 50;
/** The largest hop allowance an application may state (PX9). */
export const MAX_HOP_ALLOWANCE_MS = 1000;

/** What a client half is built from. */
export interface ProxyClientOptions {
	/** The key whose proxy the client half reaches (PX1). */
	readonly key: ProxyKey;
	/** The application's hop allowance: a whole number of milliseconds from 0 to 1000, by default 50 (PX9). */
	readonly hopAllowanceMs?: number;
	/** How the adapter connects to the key's channel and launches its proxy. */
	readonly connector: ClientConnector;
	/** The clock the bound and both deadlines are read on; on a machine, CLOCK_MONOTONIC. */
	readonly clock: HopClock;
	/** Where invocation identities take their wall-clock time and randomness from (EM11). */
	readonly identities: IdentitySource;
}

/** How a caller prepares the client half (PX5; operation-command's OC3). */
export interface PrepareOptions {
	/** The time left until the preparing deadline, in milliseconds on the client half's clock. */
	readonly timeMs: number;
	/** Stops preparing when it fires: `prepare` then rejects with the signal's reason. */
	readonly signal?: AbortSignal;
	/** The invocation, operation and repeat flag a not-delivered ending names, when the caller gives them. */
	readonly invocation?: string;
	readonly operation?: string;
	readonly repeat?: boolean;
}

/**
 * The client half: the call layer's caller interface, through the proxy. It is an `OperationCaller` (EM12): each
 * ending it gives is one the interface admits, so code written against the interface runs on it unchanged.
 */
export interface ProxyClient extends OperationCaller {
	/** Invokes a named operation through the proxy; exactly one ending, within the bound. */
	invoke(call: CallRequest): Promise<ProxiedEnding>;
	/**
	 * Prepares: connects, sends `hello` and receives `welcome`, until the deadline `timeMs` from now. Settles
	 * `ready` only when welcomed before the deadline, or already prepared; otherwise the not-delivered ending
	 * PX2 and PX6 give, which no later `welcome` supersedes.
	 */
	prepare(options: PrepareOptions): Promise<"ready" | PreparingEnding>;
	/** A new invocation identity, as EM11 writes it. */
	newInvocation(): string;
	/** Closes the client half's connections; invocations written on them end `unknown` with `proxy-lost`. */
	close(): void;
}

/** Checks a hop allowance (PX9): a whole number of milliseconds from 0 to 1000. */
export function checkHopAllowance(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_HOP_ALLOWANCE_MS) {
		throw new RangeError("a hop allowance is a whole number of milliseconds from 0 to 1000");
	}
	return value as number;
}

/** The allowance a call of `bound` milliseconds keeps: the application's, or half the bound if less, floored (PX5). */
export function allowanceFor(applicationMs: number, bound: number): number {
	return Math.min(applicationMs, Math.floor(bound / 2));
}

/** The call layer's refusal of a request that could not cross AGP whole, exactly as operation-call writes it. */
function notSendable(): RefusalRecord {
	return Object.freeze({
		part: "operation-call",
		code: "not-sendable",
		what: "The request would nest more than 30 levels, hold an integer more than 9007199254740991 from zero, or exceed 16777216 bytes as JSON.",
		why: "AGP carries no such message to any peer, so the request was not sent.",
		fix: "Make the input shallower, keep every integer within 9007199254740991 of zero, or send less, then call again.",
		details: Object.freeze({}),
	});
}

/** Builds a client half. */
export function createProxyClient(options: ProxyClientOptions): ProxyClient {
	if (options === null || typeof options !== "object") throw new TypeError("createProxyClient needs { key, connector, clock, identities }");
	const key = checkKey(options.key);
	const allowanceMs = checkHopAllowance(options.hopAllowanceMs === undefined ? DEFAULT_HOP_ALLOWANCE_MS : options.hopAllowanceMs);
	const { connector, clock, identities } = options;
	const preparer = new Preparer(key, connector, clock);

	const randomHex = (digits: number): string => {
		const hex = identities.randomHex(digits);
		if (typeof hex !== "string" || !new RegExp(`^[0-9a-f]{${digits}}$`).test(hex)) throw new TypeError(`the identity source gave ${JSON.stringify(hex)}, not ${digits} lowercase hexadecimal digits`);
		return hex;
	};
	const newInvocation = (): string => {
		const ms = Math.floor(identities.wallTimeMs());
		if (!Number.isFinite(ms) || ms < 0 || ms > 9999999999999) throw new RangeError("the identity source gave a wall-clock time that is not 13 digits of milliseconds");
		return `${String(ms).padStart(13, "0")}-${randomHex(16)}`;
	};

	/**
	 * A caller's programming error is thrown as operation-call's caller throws it (EM12): the promise invoke gives
	 * rejects with it, nothing written, and invoke itself never throws as it is called.
	 */
	const invoke = (call: CallRequest): Promise<ProxiedEnding> => {
		try {
			return invokeChecked(call);
		} catch (error) {
			return Promise.reject(error);
		}
	};
	const invokeChecked = (call: CallRequest): Promise<ProxiedEnding> => {
		// The bound starts when the caller invokes (EM12, D55): the clock is read first, then each field of
		// CallRequest at most once through operation-call's readCallRequest.
		const start = clock.nowNs();
		const checked = readCallRequest(call);
		const { host, service, operation, input, bound, repeat, signal } = checked;
		const invocation = checked.invocation ?? newInvocation();
		const deadline = start + msToNs(bound);
		const sooner = deadline - msToNs(allowanceFor(allowanceMs, bound));
		// The call layer's own checks on the caller's side (EM11), on the request it will send for this call, and
		// the line the invocation is written on (PX4).
		const attempt = `${invocation}.${randomHex(8)}`;
		const fields = { invocation, host, service, operation, input, deadline: sooner.toString(), repeat };
		const sendable = requestSendable(writeRequest({ invocation, attempt, operation }, input)) && fitsLine(fields);
		// Checked: the clock is read again, so a deadline that passed while checking - at it exactly included - wins
		// over a refusal the checks found, as in the call layer's caller, and nothing is written (PX5).
		if (clock.nowNs() >= deadline) {
			return Promise.resolve(Object.freeze({ ending: "unknown", invocation, attempt, operation, reason: "bound-passed", agpCode: null, deliveryReport: null }));
		}
		if (!sendable) return Promise.resolve(Object.freeze({ ending: "refused", invocation, attempt, operation, refusal: notSendable() }));

		return new Promise<ProxiedEnding>((resolve) => {
			let decided = false;
			let connection: Connection | undefined;
			let request: number | undefined;
			let timer: HopTimer | undefined;
			/**
			 * Settles the chosen ending: its accounting is released and the ending resolved first, and then each step
			 * of cleanup runs on its own, so a step that throws - a clock port that cannot cancel its timer among them
			 * - changes neither the ending nor any step after it (EM12).
			 */
			const decide = (ending: ProxiedEnding): void => {
				if (decided) return;
				decided = true;
				if (connection !== undefined && request !== undefined) guarded(() => connection?.decided(request as number));
				resolve(ending);
				guarded(() => timer?.cancel());
				guarded(() => signal?.removeEventListener("abort", relay));
				guarded(() => preparer.withdraw(waiter));
			};
			/**
			 * True once the deadline has passed on the clock as it is read now; a reading the port cannot give is a
			 * fault of the port, which shows nothing passed, so the event observed decides (EM12).
			 */
			const passed = (): boolean => {
				try {
					return clock.nowNs() >= deadline;
				} catch {
					return false;
				}
			};
			/** An event read now: at or after the deadline, the deadline came first and the hop stalled. */
			const read = (ending: () => ProxiedEnding): void => {
				if (decided) return;
				decide(passed() ? hopUnknown("hop-stalled", invocation, operation) : ending());
			};
			const written: WrittenInvocation = {
				invocation,
				operation,
				ended: (ending: CarriedEnding) => read(() => ending),
				lost: () => read(() => hopUnknown("proxy-lost", invocation, operation)),
			};
			const write = (c: Connection): void => {
				if (decided) return;
				if (passed()) return decide(hopUnknown("hop-stalled", invocation, operation));
				const number = c.write(written, { ...fields, aborted: signal?.aborted === true });
				// Nothing of it was written: a connection closed before writing is no proxy at all (PX6).
				if (number === undefined) return acquire();
				connection = c;
				request = number;
			};
			const waiter: Waiter = {
				deadline,
				settle: (prepared: Prepared) => {
					if (decided) return;
					switch (prepared.kind) {
						case "ready": return write(prepared.connection);
						case "refused": return decide(proxyNotDelivered(prepared.code, invocation, operation, repeat));
						case "unsafe": return decide(proxyNotDelivered("runtime-dir-unsafe", invocation, operation, repeat));
						case "late": return decide(proxyNotDelivered("proxy-unreachable", invocation, operation, repeat));
					}
				},
			};
			const acquire = (): void => {
				const current = preparer.current;
				if (current !== undefined) write(current);
				else preparer.wait(waiter);
			};
			/** Relays the process's abort across the hop once the invocation is written; before, `aborted` carries it. */
			const relay = (): void => {
				if (!decided && connection !== undefined && request !== undefined) connection.abort(request);
			};
			timer = atMoment(clock, deadline, () => {
				if (decided) return;
				decide(request === undefined
					? proxyNotDelivered("proxy-unreachable", invocation, operation, repeat)
					: hopUnknown("hop-stalled", invocation, operation));
			});
			signal?.addEventListener("abort", relay, { once: true });
			acquire();
		});
	};

	const prepare = (prepareOptions: PrepareOptions): Promise<"ready" | PreparingEnding> => {
		if (prepareOptions === null || typeof prepareOptions !== "object" || typeof prepareOptions.timeMs !== "number" || !Number.isFinite(prepareOptions.timeMs)) {
			throw new TypeError("prepare needs { timeMs }, the finite time left until its deadline in milliseconds");
		}
		const { signal } = prepareOptions;
		const unreachable = (code: PreparingEnding["proxyCode"]): PreparingEnding =>
			preparingNotDelivered(code, prepareOptions.invocation ?? null, prepareOptions.operation ?? null, prepareOptions.repeat === true);
		const now = clock.nowNs();
		if (preparer.current !== undefined) return Promise.resolve("ready");
		const deadline = now + BigInt(Math.floor(prepareOptions.timeMs * 1e6));
		if (deadline <= now) return Promise.resolve(unreachable("proxy-unreachable"));
		if (signal?.aborted === true) return Promise.reject(signal.reason);
		return new Promise((resolve, reject) => {
			let decided = false;
			let timer: HopTimer | undefined;
			/**
			 * Decides preparing, once: true for the one caller that settles it, whose settling no step of cleanup
			 * can keep back, since each step runs on its own and a step that throws changes nothing (EM12).
			 */
			const done = (): boolean => {
				if (decided) return false;
				decided = true;
				guarded(() => timer?.cancel());
				guarded(() => signal?.removeEventListener("abort", aborted));
				guarded(() => preparer.withdraw(waiter));
				return true;
			};
			const waiter: Waiter = {
				deadline,
				settle: (prepared: Prepared) => {
					if (!done()) return;
					if (prepared.kind === "ready") resolve("ready");
					else if (prepared.kind === "refused") resolve(unreachable(prepared.code));
					else resolve(unreachable(prepared.kind === "unsafe" ? "runtime-dir-unsafe" : "proxy-unreachable"));
				},
			};
			const aborted = (): void => {
				if (done()) reject(signal?.reason);
			};
			timer = atMoment(clock, deadline, () => {
				if (done()) resolve(unreachable("proxy-unreachable"));
			});
			signal?.addEventListener("abort", aborted, { once: true });
			preparer.wait(waiter);
		});
	};

	return Object.freeze({ invoke, prepare, newInvocation, close: () => preparer.close() });
}

/** Runs one step of cleanup on its own: a step that throws changes nothing already decided, nor any step after it. */
function guarded(step: () => void): void {
	try {
		step();
	} catch {
		// The ending is settled; what the step left behind finds its invocation decided.
	}
}

/** True when an invocation's `invoke` line fits the channel's line limit, its newline included (PX4). */
function fitsLine(fields: { readonly invocation: string; readonly host: string; readonly service: string; readonly operation: string; readonly input: JsonValue; readonly deadline: string; readonly repeat: boolean }): boolean {
	// The longest request number and the same deadline, so the line written can only be as long or shorter.
	const probe = writeInvoke({ ...fields, request: Number.MAX_SAFE_INTEGER, aborted: false });
	return utf8ByteLength(toCanonicalJson(probe as unknown as JsonValue)) + 1 <= CHANNEL_LIMITS.lineBytes;
}
