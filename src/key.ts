/**
 * The key a proxy serves, and its digest (CONTRACT.md, PX1).
 *
 * A key is an application and an identity, each matching `^[a-z0-9][a-z0-9-]{0,62}$`, and a target, a
 * string of 1 to 2048 characters naming what the proxy's caller connects to. The digest is the first 16
 * lowercase hexadecimal digits of the SHA-256 of the UTF-8 bytes of `<application>\n<identity>\n<target>`;
 * it names the key's channel and ownership sockets (PX2). Nothing here is particular to one runtime.
 */
import { NAME_PATTERN } from "@apnex/operation-call/message-format";
import { sha256Hex } from "./sha256.js";

/** One application's key: its identity and the target its proxy's caller connects to (PX1; zorg's D34). */
export interface ProxyKey {
	/** The application, matching `^[a-z0-9][a-z0-9-]{0,62}$`. */
	readonly application: string;
	/** The identity the proxy carries every invocation under, matching the same pattern. */
	readonly identity: string;
	/** What the proxy's caller connects to: 1 to 2048 characters. */
	readonly target: string;
}

/** The most characters a target may hold (PX1). */
export const TARGET_MAX_CHARACTERS = 2048;

/** True when a value is a name as PX1 allows for an application or an identity. */
export function isKeyName(value: unknown): value is string {
	return typeof value === "string" && NAME_PATTERN.test(value);
}

/**
 * True when a value is a target as PX1 allows: a string of 1 to 2048 characters, counted as Unicode code
 * points, and well formed, so its UTF-8 bytes - which the digest is taken over - are defined.
 */
export function isTarget(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || !value.isWellFormed()) return false;
	let characters = 0;
	for (const _ of value) if (++characters > TARGET_MAX_CHARACTERS) return false;
	return true;
}

/**
 * Checks a key and gives a plain frozen copy of it; a key that breaks PX1 is the application's programming
 * error, thrown as a TypeError naming the field.
 */
export function checkKey(key: unknown): ProxyKey {
	if (key === null || typeof key !== "object") throw new TypeError("a proxy key is { application, identity, target }");
	const { application, identity, target } = key as { [name: string]: unknown };
	if (!isKeyName(application)) throw new TypeError("a key's application must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (!isKeyName(identity)) throw new TypeError("a key's identity must match ^[a-z0-9][a-z0-9-]{0,62}$");
	if (!isTarget(target)) throw new TypeError("a key's target is a well-formed string of 1 to 2048 characters");
	return Object.freeze({ application, identity, target });
}

/** True when two keys are the same key. */
export function sameKey(a: ProxyKey, b: ProxyKey): boolean {
	return a.application === b.application && a.identity === b.identity && a.target === b.target;
}

/** The key's digest (PX1): the first 16 lowercase hexadecimal digits of the SHA-256 of its three parts. */
export function keyDigest(key: ProxyKey): string {
	const checked = checkKey(key);
	const bytes = new TextEncoder().encode(`${checked.application}\n${checked.identity}\n${checked.target}`);
	return sha256Hex(bytes).slice(0, 16);
}
