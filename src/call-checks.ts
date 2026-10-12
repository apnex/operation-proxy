/**
 * The call layer's checks on the caller's side, applied by the client half before it writes an invocation
 * (CONTRACT.md, PX5; zorg's target, EM11 and EM12), so a call through the proxy is refused or thrown exactly
 * as operation-call's caller would refuse or throw it, and every invocation the client half writes fits a
 * line of the channel.
 *
 * A caller's programming error is thrown, never an ending, and nothing is written: the same checks, in the
 * same order and with the same classes of error, as operation-call's caller makes. A call's input is read
 * once, when the call is made, into the JSON value checked and sent - each object read the first time it is
 * reached, a value holding itself not JSON. operation-call does not export its snapshot, so its walk is
 * written here to the same rule. Nothing here is particular to one runtime.
 */
import type { CallRequest, JsonValue } from "@apnex/operation-call";
import { isInvocationId, NAME_PATTERN } from "@apnex/operation-call/message-format";

/** The largest bound a caller may give, in milliseconds (EM12). */
export const MAX_BOUND_MS = 2147483647;

/**
 * A plain copy of a value, reading each member exactly once, or undefined when it is not JSON: null, a
 * boolean, a finite number, a string, or arrays with no holes and plain objects of them. An object reached
 * by two paths is read once and its first copy given again; a value holding itself is not JSON. The walk
 * keeps its own stack, so a value of any depth is walked to the end.
 */
export function snapshotJson(value: unknown): JsonValue | undefined {
	interface Slot { readonly value: unknown; readonly store: (copy: JsonValue) => void }
	interface Exit { readonly item: object; readonly copy: JsonValue; readonly depth: number }
	let result: JsonValue | undefined;
	const stack: Slot[] = [{ value, store: (copy) => { result = copy; } }];
	const open = new Set<object>();
	const done = new Map<object, JsonValue>();
	const exits: Exit[] = [];
	while (stack.length > 0) {
		while (exits.length > 0 && (exits.at(-1) as Exit).depth >= stack.length) {
			const exit = exits.pop() as Exit;
			open.delete(exit.item);
			done.set(exit.item, exit.copy);
		}
		const { value: item, store } = stack.pop() as Slot;
		if (item === null || typeof item === "boolean" || typeof item === "string") {
			store(item);
			continue;
		}
		if (typeof item === "number") {
			if (!Number.isFinite(item)) return undefined;
			store(item);
			continue;
		}
		if (typeof item !== "object") return undefined;
		const first = done.get(item);
		if (first !== undefined) {
			store(first);
			continue;
		}
		if (open.has(item)) return undefined;
		const members: [string | number, unknown][] = [];
		let copy: JsonValue[] | { [name: string]: JsonValue };
		if (Array.isArray(item)) {
			const length = item.length;
			for (let i = 0; i < length; i++) {
				if (!(i in item)) return undefined;
				members.push([i, item[i]]);
			}
			copy = new Array<JsonValue>(length);
		} else {
			const proto = Object.getPrototypeOf(item);
			if (proto !== Object.prototype && proto !== null) return undefined;
			for (const name of Object.keys(item)) members.push([name, (item as { [name: string]: unknown })[name]]);
			copy = {};
		}
		store(copy);
		open.add(item);
		exits.push({ item, copy, depth: stack.length });
		const target = copy as { [key: string | number]: JsonValue };
		for (let i = members.length - 1; i >= 0; i--) {
			const [key, member] = members[i] as [string | number, unknown];
			stack.push({ value: member, store: (c) => { Object.defineProperty(target, key, { value: c, enumerable: true, writable: true, configurable: true }); } });
		}
	}
	return result;
}

/** Reads a call's input once into its JSON value; an input that is not JSON, or cannot be read, is a TypeError. */
function snapshotInput(input: unknown): JsonValue {
	let snapshot: JsonValue | undefined;
	try {
		snapshot = snapshotJson(input);
	} catch (error) {
		throw new TypeError("a call's input could not be read as a JSON value", { cause: error });
	}
	if (snapshot === undefined) throw new TypeError("a call's input must be a JSON value");
	return snapshot;
}

/**
 * Checks a call's arguments as operation-call's caller does, in its order, and gives the input's snapshot;
 * a call that breaks them is the caller's programming error, thrown, and nothing is written.
 */
export function checkCall(call: CallRequest): JsonValue {
	if (call === null || typeof call !== "object") throw new TypeError("invoke needs a call: { host, service, operation, input, bound }");
	if (typeof call.host !== "string" || call.host.length === 0) throw new TypeError("a call names the host it means as an AGP node identifier");
	if (typeof call.service !== "string" || !NAME_PATTERN.test(call.service)) throw new TypeError("a call's service must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (typeof call.operation !== "string" || !NAME_PATTERN.test(call.operation)) throw new TypeError("a call's operation must match ^[a-z0-9][a-z0-9-]{0,62}$");
	const input = snapshotInput(call.input);
	if (!Number.isInteger(call.bound) || call.bound < 1 || call.bound > MAX_BOUND_MS) throw new RangeError("a call's bound is a whole number of milliseconds from 1 to 2147483647");
	if (call.invocation !== undefined && !isInvocationId(call.invocation)) throw new TypeError("a call's invocation must be an invocation identity as EM11 writes it");
	if (call.repeat !== undefined && typeof call.repeat !== "boolean") throw new TypeError("a call's repeat flag is true or false");
	if (call.signal !== undefined && (call.signal === null || typeof call.signal.aborted !== "boolean")) throw new TypeError("a call's signal must be an AbortSignal");
	return input;
}

/** The size in UTF-8 bytes of a string, a lone surrogate counted as the three bytes of U+FFFD. */
export function utf8Bytes(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}
