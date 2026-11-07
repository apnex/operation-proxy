/**
 * How an invocation through the proxy ends (CONTRACT.md, PX6; zorg's target, EM12): the call layer's four
 * endings unchanged, and the endings the proxy and the client half decide themselves.
 *
 * A `not-delivered` ending of the call layer carries `proxyCode` `null`; one of the proxy carries `agpCode`
 * `null` and its own `proxyCode`; an `unknown` ending the client half decides carries the hop's `reason`,
 * `agpCode` `null` and `deliveryReport` `null`. An ending the proxy or the client half decides names no
 * attempt - `attempt` is `null` - since no attempt of the call layer is known to it; an ending refused before
 * writing, exactly as the call layer would refuse it, names the attempt identity it was refused as.
 * Nothing here is particular to one runtime.
 */
import { readCallEnding, readRefusalRecord, type CallLayerEnding, type CallLayerUnknownReason, type DeliveryReport, type HopNotDeliveredEnding, type HopUnknownEnding, type HopUnknownReason, type JsonValue, type RefusalRecord } from "@apnex/operation-call";
import { crossesAgp, isAttemptId, isInvocationId, NAME_PATTERN, readMessage, writeEnd, type EndContent } from "@apnex/operation-call/message-format";

/** The proxy's codes on a `not-delivered` ending (PX2, PX4, PX5, PX6, PX7, PX9). */
export type ProxyCode = "proxy-unreachable" | "key-mismatch" | "version" | "deadline-passed" | "runtime-dir-unsafe" | "proxy-stopping" | "admission-refused";

/** The hop's reasons on an `unknown` ending the client half decides (PX6): the reasons a hop adds (EM12). */
export type HopReason = HopUnknownReason;

/**
 * A `not-delivered` ending the proxy or the client half decides for an invocation: nothing of it was handed on.
 * It is the caller interface's ending of a hop that handed nothing on (EM12), naming the proxy's code.
 */
export interface ProxyNotDeliveredEnding extends HopNotDeliveredEnding {
	readonly proxyCode: ProxyCode;
}

/**
 * The `not-delivered` ending of preparing alone (PX5, PX6): as an invocation's, naming the invocation and the
 * operation only where the caller gives them.
 */
export interface PreparingEnding {
	readonly ending: "not-delivered";
	readonly invocation: string | null;
	readonly attempt: null;
	readonly operation: string | null;
	readonly agpCode: null;
	readonly proxyCode: ProxyCode;
	readonly earlierAttemptsUncertain: boolean;
}

/** An `unknown` ending the client half decides, where the hop lost certainty (PX6; EM12). */
export type { HopUnknownEnding };

/**
 * How an invocation through the proxy ends: the call layer's ending, or the proxy's or the hop's. Every one is a
 * `CallEnding`, the caller interface's ending (EM12), so the client half is an `OperationCaller`.
 */
export type ProxiedEnding = CallLayerEnding | ProxyNotDeliveredEnding | HopUnknownEnding;

/** The proxy's own ending in an `end` message: `deadline-passed` (PX5), `proxy-stopping` (PX7), or `admission-refused` (PX6, PX9). */
export type DeadlinePassedEnding = ProxyNotDeliveredEnding & { readonly proxyCode: "deadline-passed" | "proxy-stopping" | "admission-refused" };

/** The ending the proxy itself writes in an `end` message: the call layer's, or its `deadline-passed`, `proxy-stopping` or `admission-refused`. */
export type CarriedEnding = CallLayerEnding | DeadlinePassedEnding;

/** The proxy's codes an `end` message may carry, on a `not-delivered` ending of its own (PX6, PX9). */
const CARRIED_PROXY_CODES: readonly ProxyCode[] = ["deadline-passed", "proxy-stopping", "admission-refused"];

const UNKNOWN_REASONS: readonly CallLayerUnknownReason[] = ["bound-passed", "operation-failed", "answer-not-sendable", "part-missing"];

/** True for a plain object, not null and not an array. */
export function isObject(value: unknown): value is { readonly [name: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when an object holds exactly the names given, in any order. */
export function hasExactly(value: { readonly [name: string]: unknown }, names: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === names.length && names.every((n) => Object.hasOwn(value, n));
}

/** True when a value has exactly the form of EM9's refusal record as plain data (zorg's D54, D55). */
export function isRefusalRecord(value: unknown): value is RefusalRecord {
	return readRefusalRecord(value).ok;
}

/**
 * True when the values an answered or refused ending carries keep the call layer's rules (EM11, EM12): the end
 * message of the call layer that carries them is one the call layer reads - JSON, every number finite - and one
 * that crosses AGP whole - at most 30 levels, the message itself the first, every integer within 9007199254740991
 * of zero. The call layer's own checks walk a value with a stack of their own, never the call stack, so a value
 * nested to any depth is judged, and refused, without overflowing it.
 */
function keepsCallLayerRules(invocation: string, attempt: string, operation: string, content: EndContent): boolean {
	const message = writeEnd({ invocation, attempt, operation }, content);
	return readMessage(message) !== undefined && crossesAgp(message as unknown as JsonValue);
}

/**
 * Reads the `ending` of an `end` message or a `CallLayerCaller.invoke` result as plain data through
 * operation-call's `readCallEnding` and `readRefusalRecord` (PX4, PX6, PX9; zorg's D54, D55): the call layer's
 * ending as EM12 gives it - exactly its fields, naming the invocation and the operation it was asked for, its
 * answer or refusal keeping the call layer's JSON, number and depth rules - or the proxy's `deadline-passed` or
 * `proxy-stopping`.
 * Anything else is undefined (with any native promises observed by `readCallEnding`).
 */
export function readCarriedEnding(value: unknown, invocation: string, operation: string): CarriedEnding | undefined {
	const reading = readCallEnding(value);
	if (!reading.ok || !isInvocationId(invocation) || !NAME_PATTERN.test(operation)) return undefined;
	const ending = reading.ending;
	if (ending.invocation !== invocation || ending.operation !== operation) return undefined;
	const attempt = ending.attempt;
	const callAttempt = typeof attempt === "string" && isAttemptId(attempt) && attempt.startsWith(`${invocation}.`);
	switch (ending.ending) {
		case "answered":
			return callAttempt && keepsCallLayerRules(invocation, attempt, operation, { outcome: "answered", answer: ending.answer })
				? (ending as CarriedEnding) : undefined;
		case "refused":
			return callAttempt && keepsCallLayerRules(invocation, attempt, operation, { outcome: "refused", refusal: ending.refusal })
				? (ending as CarriedEnding) : undefined;
		case "not-delivered": {
			const ofCallLayer = callAttempt && typeof ending.agpCode === "string" && ending.proxyCode === null;
			const ofProxy = attempt === null && ending.agpCode === null && CARRIED_PROXY_CODES.includes(ending.proxyCode as ProxyCode);
			return ofCallLayer || ofProxy ? (ending as CarriedEnding) : undefined;
		}
		case "unknown":
			return callAttempt && UNKNOWN_REASONS.includes(ending.reason as CallLayerUnknownReason)
				? (ending as CarriedEnding) : undefined;
	}
}

/** A `not-delivered` ending of the proxy's own code for an invocation (PX2, PX5, PX6). */
export function proxyNotDelivered<C extends ProxyCode>(proxyCode: C, invocation: string, operation: string, repeat: boolean): ProxyNotDeliveredEnding & { readonly proxyCode: C } {
	return Object.freeze({ ending: "not-delivered", invocation, attempt: null, operation, agpCode: null, proxyCode, earlierAttemptsUncertain: repeat });
}

/** The `not-delivered` ending of preparing alone, naming what the caller gave (PX5, PX6). */
export function preparingNotDelivered(proxyCode: ProxyCode, invocation: string | null, operation: string | null, repeat: boolean): PreparingEnding {
	return Object.freeze({ ending: "not-delivered", invocation, attempt: null, operation, agpCode: null, proxyCode, earlierAttemptsUncertain: repeat });
}

/** An `unknown` ending of the hop's reason (PX6). */
export function hopUnknown(reason: HopReason, invocation: string, operation: string): HopUnknownEnding {
	return Object.freeze({ ending: "unknown", invocation, attempt: null, operation, reason, agpCode: null, deliveryReport: null });
}

/** Types re-used by the halves. */
export type { DeliveryReport, JsonValue };
