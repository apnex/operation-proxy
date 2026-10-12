// key - the key a proxy serves and its digest (CONTRACT.md, PX1), checked in this process. Needs no socket.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createProxyClient, createProxyHalf, keyDigest } from "@apnex/operation-proxy";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { sha256Hex } from "../../dist/sha256.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";

const connector = { connect: async () => ({ kind: "absent" }), launch: () => undefined };
const clock = createManualHopClock();

test("the SHA-256 written out matches the system's for inputs across block boundaries", () => {
	for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4097]) {
		const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
		assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `${n} bytes`);
	}
});

test("PX1: a key's digest is the first 16 lowercase hexadecimal digits of the SHA-256 of <application>\\n<identity>\\n<target> in UTF-8", () => {
	const keys = [
		{ application: "zorg", identity: "alice", target: "ws://192.168.1.20:47100/agp zorg-hub" },
		{ application: "zorg", identity: "alice", target: "ws://192.168.1.20:47100/agp zorg-hub-2" },
		{ application: "a", identity: "b", target: "caf\u00e9 \u{1F600} \u4e2d" },
		{ application: "a".repeat(63), identity: "0-9", target: "x".repeat(2048) },
	];
	for (const key of keys) {
		const expected = createHash("sha256").update(`${key.application}\n${key.identity}\n${key.target}`, "utf8").digest("hex").slice(0, 16);
		assert.equal(keyDigest(key), expected);
		assert.match(keyDigest(key), /^[0-9a-f]{16}$/);
	}
	assert.notEqual(keyDigest(keys[0]), keyDigest(keys[1]), "two keys differing only in target have two digests");
});

test("PX1: an application and an identity match ^[a-z0-9][a-z0-9-]{0,62}$, and a target is a string of 1 to 2048 characters; any other key is the application's programming error", () => {
	const good = { application: "zorg", identity: "alice", target: "t" };
	for (const key of [good, { ...good, target: "\u{1F600}".repeat(2048) }, { ...good, application: "a".repeat(63) }, { ...good, identity: "9-" }]) {
		assert.doesNotThrow(() => createProxyClient({ key, connector, clock, identities: machineIdentities }));
	}
	const bad = [
		{ ...good, application: "Zorg" }, { ...good, application: "-zorg" }, { ...good, application: "a".repeat(64) }, { ...good, application: "" },
		{ ...good, identity: "alice.b" }, { ...good, identity: 7 }, { ...good, target: "" }, { ...good, target: "x".repeat(2049) },
		{ ...good, target: "\u{1F600}".repeat(2049) }, { ...good, target: "\ud800" }, { ...good, target: 5 }, null, "zorg",
	];
	for (const key of bad) {
		assert.throws(() => createProxyClient({ key, connector, clock, identities: machineIdentities }), TypeError, JSON.stringify(key));
		assert.throws(() => keyDigest(key), TypeError);
		assert.throws(() => createProxyHalf({ key, clock, idleMs: 1000, onIdle: () => undefined }), TypeError);
	}
});

