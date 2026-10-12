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
import type { CallLayerEnding, CallLayerUnknownReason, DeliveryReport, HopNotDeliveredEnding, HopUnknownEnding, HopUnknownReason, JsonValue, RefusalRecord } from "@apnex/operation-call";
import { crossesAgp, isAttemptId, isInvocationId, NAME_PATTERN, readMessage, writeEnd, type EndContent } from "@apnex/operation-call/message-format";

/** The proxy's codes on a `not-delivered` ending (PX2, PX5, PX6). */
export type ProxyCode = "proxy-unreachable" | "key-mismatch" | "version" | "deadline-passed" | "runtime-dir-unsafe";

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

/** The proxy's own ending in an `end` message: `deadline-passed` (PX5). */
export type DeadlinePassedEnding = ProxyNotDeliveredEnding & { readonly proxyCode: "deadline-passed" };

/** The ending the proxy itself writes in an `end` message: the call layer's, or its `deadline-passed`. */
export type CarriedEnding = CallLayerEnding | DeadlinePassedEnding;

const REFUSAL_FIELDS = ["code", "details", "fix", "part", "what", "why"];
const MISFIT_FIELDS = ["expected", "fit", "keyword", "pointer"];
const UNKNOWN_REASONS: readonly CallLayerUnknownReason[] = ["bound-passed", "operation-failed", "answer-not-sendable"];

/** True for a plain object, not null and not an array. */
export function isObject(value: unknown): value is { readonly [name: string]: unknown } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when an object holds exactly the names given, in any order. */
export function hasExactly(value: { readonly [name: string]: unknown }, names: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === names.length && names.every((n) => Object.hasOwn(value, n));
}

/** True when a value has exactly the form of EM9's refusal record, as the call layer checks it. */
export function isRefusalRecord(value: unknown): value is RefusalRecord {
	if (!isObject(value)) return false;
	const names = Object.keys(value).filter((n) => n !== "misfits").sort();
	if (names.length !== REFUSAL_FIELDS.length || !names.every((n, i) => n === REFUSAL_FIELDS[i])) return false;
	if (!["part", "code", "what", "why", "fix"].every((n) => typeof value[n] === "string")) return false;
	if (!isObject(value.details)) return false;
	if (!Object.hasOwn(value, "misfits")) return true;
	const misfits = value.misfits;
	return Array.isArray(misfits) && misfits.every((m) => {
		if (!isObject(m)) return false;
		const own = Object.keys(m).sort();
		return own.length === 4 && own.every((n, i) => n === MISFIT_FIELDS[i]) && typeof m.pointer === "string" && typeof m.keyword === "string" && typeof m.fit === "string";
	});
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
 * Reads the `ending` of an `end` message (PX4): the call layer's ending as EM12 gives it - exactly its
 * fields, naming the invocation and the operation it was asked for, its answer or refusal keeping the call
 * layer's JSON, number and depth rules - or the proxy's `deadline-passed`. Anything else is undefined, which
 * breaks the channel's table.
 */
export function readCarriedEnding(value: unknown, invocation: string, operation: string): CarriedEnding | undefined {
	if (!isObject(value) || value.invocation !== invocation || value.operation !== operation || !isInvocationId(invocation) || !NAME_PATTERN.test(operation)) return undefined;
	const address = ["ending", "invocation", "attempt", "operation"];
	const attempt = value.attempt;
	const callAttempt = isAttemptId(attempt) && attempt.startsWith(`${invocation}.`);
	switch (value.ending) {
		case "answered":
			return callAttempt && hasExactly(value, [...address, "answer"]) && keepsCallLayerRules(invocation, attempt, operation, { outcome: "answered", answer: value.answer as JsonValue })
				? value as unknown as CarriedEnding : undefined;
		case "refused":
			return callAttempt && hasExactly(value, [...address, "refusal"]) && isRefusalRecord(value.refusal) && keepsCallLayerRules(invocation, attempt, operation, { outcome: "refused", refusal: value.refusal })
				? value as unknown as CarriedEnding : undefined;
		case "not-delivered": {
			if (!hasExactly(value, [...address, "agpCode", "proxyCode", "earlierAttemptsUncertain"]) || typeof value.earlierAttemptsUncertain !== "boolean") return undefined;
			const ofCallLayer = callAttempt && typeof value.agpCode === "string" && value.proxyCode === null;
			const ofProxy = attempt === null && value.agpCode === null && value.proxyCode === "deadline-passed";
			return ofCallLayer || ofProxy ? value as unknown as CarriedEnding : undefined;
		}
		case "unknown":
			return callAttempt && hasExactly(value, [...address, "reason", "agpCode", "deliveryReport"])
				&& UNKNOWN_REASONS.includes(value.reason as CallLayerUnknownReason)
				&& (value.agpCode === null || typeof value.agpCode === "string")
				&& (value.deliveryReport === null || value.deliveryReport === "delivered" || value.deliveryReport === "unknown")
				? value as unknown as CarriedEnding : undefined;
		default:
			return undefined;
	}
}

/**
 * Deep-freezes an ending as it was read, so nothing that held the message can change it. It walks with a stack of
 * its own, never the call stack, so no nesting can overflow it.
 */
export function freezeEnding<T extends ProxiedEnding>(ending: T): T {
	const stack: unknown[] = [ending];
	while (stack.length > 0) {
		const value = stack.pop();
		if (value === null || typeof value !== "object" || Object.isFrozen(value)) continue;
		Object.freeze(value);
		for (const member of Object.values(value)) stack.push(member);
	}
	return ending;
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
