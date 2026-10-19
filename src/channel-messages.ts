/**
 * The channel's messages (CONTRACT.md, PX4): objects holding `operationProxy`, which is 1, `type`, and
 * exactly the fields its type names, carried one per line as newline-delimited JSON in UTF-8, each line at
 * most 16785408 bytes with its newline - the largest request message the call layer sends, 16777216 bytes
 * (zorg's target, EM11), and 8192 bytes for the channel's own fields.
 *
 * | Direction | type | Fields |
 * |---|---|---|
 * | client to proxy | hello | key |
 * | proxy to client | welcome | none |
 * | proxy to client | refused | code: key-mismatch or version |
 * | client to proxy | invoke | request, invocation, host, service, operation, input, deadline, repeat, aborted, parts |
 * | client to proxy | abort | request |
 * | proxy to client | end | request, ending |
 * | proxy to client | part | request, sequence, answer |
 * | proxy to client | alive | request |
 *
 * `deadline` is the moment the proxy's call's bound passes (PX5): on a machine, nanoseconds on Linux's
 * CLOCK_MONOTONIC, written in decimal as a JSON string, so a reading past 2^53 nanoseconds keeps every digit.
 * The readers give a message only when it has exactly its type's form, and undefined otherwise, which closes
 * the connection. A `part` and an `alive` go only for a request written with `parts` true, before its `end`
 * (zorg's Delta 4, stage 6; D64). Nothing here is particular to one runtime.
 */
import type { JsonValue } from "@apnex/operation-call";
import { readPlainJson } from "@apnex/shape-check";
import { crossesAgp, isInvocationId, MESSAGE_LIMITS, NAME_PATTERN, readMessage, writePart } from "@apnex/operation-call/message-format";
import { hasExactly, isObject, readCarriedEnding, type CarriedEnding } from "./endings.js";
import type { ProxyKey } from "./key.js";

/** The channel's version, which every message holds as `operationProxy`. */
export const CHANNEL_VERSION = 1;

/** The limits of the channel (PX4). */
export const CHANNEL_LIMITS = Object.freeze({
	/** The largest request message the call layer sends (EM11). */
	requestBytes: MESSAGE_LIMITS.requestBytes,
	/** Bytes held for the channel's own fields. */
	channelFieldBytes: 8192,
	/** The longest line, its newline included: 16777216 + 8192. */
	lineBytes: MESSAGE_LIMITS.requestBytes + 8192,
	/**
	 * The most a proxy keeps unwritten on one connection, or posted and not yet taken on one browser port: twice the
	 * longest line, 33570816 bytes (PX6, PX8).
	 */
	unwrittenBytes: 2 * (MESSAGE_LIMITS.requestBytes + 8192),
});

/** The codes of a `refused` message. */
export type RefusalCode = "key-mismatch" | "version";

/** client to proxy: the first message on a connection. */
export interface HelloMessage { readonly operationProxy: 1; readonly type: "hello"; readonly key: ProxyKey }
/** proxy to client: the proxy's caller is ready by the application's own test (PX9). */
export interface WelcomeMessage { readonly operationProxy: 1; readonly type: "welcome" }
/** proxy to client: a key other than the proxy's, or a version other than 1; the proxy then closes. */
export interface RefusedMessage { readonly operationProxy: 1; readonly type: "refused"; readonly code: RefusalCode }
/** client to proxy: one invocation, for the proxy to hand to its caller (PX5). */
export interface InvokeMessage {
	readonly operationProxy: 1;
	readonly type: "invoke";
	readonly request: number;
	readonly invocation: string;
	readonly host: string;
	readonly service: string;
	readonly operation: string;
	readonly input: JsonValue;
	readonly deadline: string;
	readonly repeat: boolean;
	readonly aborted: boolean;
	/** True when the call request gives `onPart`: the call accepts parts (PX5). */
	readonly parts: boolean;
}
/** client to proxy: the process aborted the invocation; the proxy fires the call's abort signal. */
export interface AbortMessage { readonly operationProxy: 1; readonly type: "abort"; readonly request: number }
/** proxy to client: how the invocation ended. */
export interface EndMessage { readonly operationProxy: 1; readonly type: "end"; readonly request: number; readonly ending: CarriedEnding }
/** proxy to client: the next part of an invocation written with `parts` true, as the proxy's call gave it (PX5). */
export interface PartMessage { readonly operationProxy: 1; readonly type: "part"; readonly request: number; readonly sequence: number; readonly answer: JsonValue }
/** proxy to client: a sign of life of an invocation written with `parts` true (PX5). */
export interface AliveMessage { readonly operationProxy: 1; readonly type: "alive"; readonly request: number }

/** A message from a client to a proxy. */
export type ClientMessage = HelloMessage | InvokeMessage | AbortMessage;
/** A message from a proxy to a client. */
export type ProxyMessage = WelcomeMessage | RefusedMessage | EndMessage | PartMessage | AliveMessage;
/** Any message of the channel. */
export type ChannelMessage = ClientMessage | ProxyMessage;

/** Writes a `hello`. */
export function writeHello(key: ProxyKey): HelloMessage {
	return { operationProxy: 1, type: "hello", key: { application: key.application, identity: key.identity, target: key.target } };
}

/** Writes a `welcome`. */
export function writeWelcome(): WelcomeMessage {
	return { operationProxy: 1, type: "welcome" };
}

/** Writes a `refused`. */
export function writeRefused(code: RefusalCode): RefusedMessage {
	return { operationProxy: 1, type: "refused", code };
}

/** What an `invoke` carries besides its head. */
export type InvokeFields = Omit<InvokeMessage, "operationProxy" | "type">;

/** Writes an `invoke`, its fields in the order PX4 lists them. */
export function writeInvoke(f: InvokeFields): InvokeMessage {
	return {
		operationProxy: 1, type: "invoke", request: f.request, invocation: f.invocation, host: f.host, service: f.service,
		operation: f.operation, input: f.input, deadline: f.deadline, repeat: f.repeat, aborted: f.aborted, parts: f.parts,
	};
}

/** Writes an `abort`. */
export function writeAbort(request: number): AbortMessage {
	return { operationProxy: 1, type: "abort", request };
}

/** Writes an `end`. */
export function writeEnd(request: number, ending: CarriedEnding): EndMessage {
	return { operationProxy: 1, type: "end", request, ending };
}

/** Writes a `part`. */
export function writePartMessage(request: number, sequence: number, answer: JsonValue): PartMessage {
	return { operationProxy: 1, type: "part", request, sequence, answer };
}

/** Writes an `alive`. */
export function writeAliveMessage(request: number): AliveMessage {
	return { operationProxy: 1, type: "alive", request };
}

/** True for a request number: a whole number from 1. */
export function isRequestNumber(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

/** True for a deadline as a machine writes it: decimal digits with no sign and no leading zero. */
export function isMachineDeadline(value: unknown): value is string {
	return typeof value === "string" && /^(0|[1-9][0-9]{0,29})$/.test(value);
}

/** Reads an incoming channel value as plain JSON data (zorg's D54, D55), or undefined. */
function plainObject(raw: unknown): { readonly [name: string]: unknown } | undefined {
	const plain = readPlainJson(raw);
	return plain.ok && isObject(plain.value) ? plain.value : undefined;
}

/** True when a plain object holds `operationProxy` 1 and the type given. */
function headed(value: { readonly [name: string]: unknown } | undefined, type: string): boolean {
	return value !== undefined && value.operationProxy === CHANNEL_VERSION && value.type === type;
}

/** True when a value is a plain object whose `operationProxy` is not 1: a version the proxy refuses (PX4). */
export function isOtherVersion(raw: unknown): boolean {
	const value = plainObject(raw);
	return value !== undefined && value.operationProxy !== CHANNEL_VERSION;
}

/** Reads a `hello`; its key's three fields must be strings, compared with the proxy's own as they are. */
export function readHello(raw: unknown): HelloMessage | undefined {
	const value = plainObject(raw);
	if (value === undefined || !headed(value, "hello") || !hasExactly(value, ["operationProxy", "type", "key"])) return undefined;
	const key = value.key;
	if (!isObject(key) || !hasExactly(key, ["application", "identity", "target"])) return undefined;
	if (typeof key.application !== "string" || typeof key.identity !== "string" || typeof key.target !== "string") return undefined;
	return value as unknown as HelloMessage;
}

/** Reads an `invoke` or an `abort`, the messages a client sends once welcomed. */
export function readInvokeOrAbort(raw: unknown): InvokeMessage | AbortMessage | undefined {
	const value = plainObject(raw);
	if (value === undefined) return undefined;
	if (headed(value, "abort")) return hasExactly(value, ["operationProxy", "type", "request"]) && isRequestNumber(value.request) ? value as unknown as AbortMessage : undefined;
	if (!headed(value, "invoke")) return undefined;
	const names = ["operationProxy", "type", "request", "invocation", "host", "service", "operation", "input", "deadline", "repeat", "aborted", "parts"];
	if (!hasExactly(value, names) || !isRequestNumber(value.request) || !isInvocationId(value.invocation)) return undefined;
	if (typeof value.host !== "string" || value.host.length === 0) return undefined;
	if (typeof value.service !== "string" || !NAME_PATTERN.test(value.service) || typeof value.operation !== "string" || !NAME_PATTERN.test(value.operation)) return undefined;
	if (!isMachineDeadline(value.deadline) || typeof value.repeat !== "boolean" || typeof value.aborted !== "boolean" || typeof value.parts !== "boolean") return undefined;
	return value as unknown as InvokeMessage;
}

/** Reads a `welcome` or a `refused`, the messages a proxy may send before it welcomes. */
export function readWelcomeOrRefused(raw: unknown): WelcomeMessage | RefusedMessage | undefined {
	const value = plainObject(raw);
	if (value === undefined) return undefined;
	if (headed(value, "welcome")) return hasExactly(value, ["operationProxy", "type"]) ? value as unknown as WelcomeMessage : undefined;
	if (headed(value, "refused") && hasExactly(value, ["operationProxy", "type", "code"]) && (value.code === "key-mismatch" || value.code === "version")) {
		return value as unknown as RefusedMessage;
	}
	return undefined;
}

/** What a client asked of a request it wrote and whose `end` it has not read. */
export interface AskedRequest {
	readonly invocation: string;
	readonly operation: string;
	/** True when it wrote the request with `parts` true. */
	readonly parts: boolean;
	/** The `sequence` the request's next part must hold. */
	readonly nextSequence: number;
}

/**
 * Reads an `end`, a `part` or an `alive` for one of the requests a client wrote and whose `end` it has not read,
 * given what it asked of each (PX4): a request it never wrote, an ending not of that invocation and operation,
 * a `part` or an `alive` for a request written with `parts` false, a part whose `sequence` is not the next or
 * whose answer the call layer would not carry (EM11), or a field the table does not name, is undefined.
 */
export function readProxyMessage(raw: unknown, asked: (request: number) => AskedRequest | undefined): EndMessage | PartMessage | AliveMessage | undefined {
	const value = plainObject(raw);
	if (value === undefined || !isRequestNumber(value.request)) return undefined;
	const what = asked(value.request);
	if (what === undefined) return undefined;
	if (headed(value, "end")) {
		if (!hasExactly(value, ["operationProxy", "type", "request", "ending"])) return undefined;
		const ending = readCarriedEnding(value.ending, what.invocation, what.operation);
		return ending === undefined ? undefined : Object.freeze({ operationProxy: 1, type: "end", request: value.request, ending });
	}
	if (!what.parts) return undefined;
	if (headed(value, "alive")) return hasExactly(value, ["operationProxy", "type", "request"]) ? Object.freeze({ operationProxy: 1, type: "alive", request: value.request }) : undefined;
	if (!headed(value, "part") || !hasExactly(value, ["operationProxy", "type", "request", "sequence", "answer"]) || value.sequence !== what.nextSequence) return undefined;
	// The answer keeps the call layer's rules: the part message the call layer carries it in is one it reads and
	// one that crosses AGP whole (EM11), so a part reaches `onPart` exactly as a direct call would give it.
	const answer = value.answer as JsonValue;
	const carried = writePart({ invocation: what.invocation, attempt: `${what.invocation}.00000000`, operation: what.operation }, what.nextSequence, answer);
	if (readMessage(carried) === undefined || !crossesAgp(carried as unknown as JsonValue)) return undefined;
	return Object.freeze({ operationProxy: 1, type: "part", request: value.request, sequence: what.nextSequence, answer });
}
