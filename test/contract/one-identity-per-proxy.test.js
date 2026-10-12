// one-identity-per-proxy - each proxy carries one application's invocations under one identity to one target,
// through one caller of the call layer and its one connection, invocations from processes running at once
// carried at the same time, and never a process's invocation under another identity (CONTRACT.md, PX1, PX9;
// zorg's E17, D34).
//
// Needs Unix sockets, abstract-namespace sockets and child processes: the fixture application's clients and
// proxies are real processes. The key's digest and the checks of what an application supplies, which need no
// socket, are in test/unit/key.test.js and test/unit/application.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { rawConnection } from "../support/case-hop.js";
import { fixture, waitFor } from "../support/processes.js";

const fixtures = [];
const make = (options) => {
	const f = fixture(options);
	fixtures.push(f);
	return f;
};
after(async () => { for (const f of fixtures) await f.cleanup(); });


test("PX1: two keys differing only in target get two proxies, each owning its own key, each with its own channel", { timeout: 120_000 }, async () => {
	const one = make();
	const two = make({ key: { ...one.config.key, target: "fixture host-a, another hub" }, runtimeDir: one.config.runtimeDir });
	assert.notEqual(one.digest, two.digest);
	const [a, b] = await Promise.all([one.client({ operation: "which" }).ack(60_000), two.client({ operation: "which" }).ack(60_000)]);
	assert.notEqual(a.ending.answer.pid, b.ending.answer.pid, "two proxies");
	assert.ok(fs.existsSync(one.socketPath()) && fs.existsSync(two.socketPath()) && one.socketPath() !== two.socketPath());
	const unix = fs.readFileSync("/proc/net/unix", "utf8");
	const secret = fs.readFileSync(path.join(one.config.runtimeDir, "secret"), "utf8").trim();
	for (const f of [one, two]) assert.ok(unix.includes(`@operation-proxy-${secret}-${f.digest}`), `the ownership socket of ${f.digest}`);
});

test("PX1: one key used from 20 processes gets one proxy, its one caller carrying them all under the key's identity", { timeout: 120_000 }, async () => {
	const f = make();
	const acks = await Promise.all(Array.from({ length: 20 }, () => f.client({ operation: "which", connectMs: 30_000, bound: 30_000 }).ack(90_000)));
	assert.equal(new Set(acks.map((a) => a.ending.answer.pid)).size, 1, "one proxy");
	assert.equal(new Set(acks.map((a) => a.ending.answer.node)).size, 1, "one caller, on one node");
	assert.equal(f.owners().length, 1);
	assert.equal(fs.readFileSync(path.join(f.records, "built.ndjson"), "utf8").trim().split("\n").length, 1, "the caller was built once");
});

test("PX1: invocations from processes running at once are carried at the same time, and never under another identity", { timeout: 120_000 }, async () => {
	const f = make();
	await f.client({ operation: "which" }).ack();
	const n = 6;
	const acks = await Promise.all(Array.from({ length: n }, () => f.client({ operation: "gather", input: { n } }).ack(60_000)));
	for (const ack of acks) assert.deepEqual([ack.ending.ending, ack.ending.answer.together], ["answered", n], "every one was in flight with the others");
	const identity = f.config.key.identity;
	for (const run of f.runs()) assert.ok(run.origin.startsWith(`${identity}.`), `${run.origin} is a node of the identity ${identity}`);
	const built = JSON.parse(fs.readFileSync(path.join(f.records, "built.ndjson"), "utf8").trim());
	assert.deepEqual(built.key, f.config.key, "the application built the proxy's caller from the key");
	const stranger = await rawConnection(f.socketPath());
	stranger.send({ operationProxy: 1, type: "hello", key: { ...f.config.key, identity: "mallory" } });
	await waitFor(() => stranger.closed(), "the stranger's connection closed");
	assert.deepEqual(stranger.lines, [{ operationProxy: 1, type: "refused", code: "key-mismatch" }], "a process of another identity is refused, never carried");
});

test("PX9: the proxy welcomes only once the application's own test says its caller is ready", { timeout: 120_000 }, async () => {
	const f = make();
	f.set({ readyAfterFile: path.join(f.records, "ready-now") });
	f.proxy();
	await waitFor(() => f.stages().some((s) => s.stage === "built"), "the proxy to build its caller", 60_000);
	const early = await f.client({ operation: "which", connectMs: 1500, prepareOnly: true }).ack(60_000);
	assert.equal(early.ending.proxyCode, "proxy-unreachable", "not welcomed before the application's test passes");
	assert.equal(f.owners().length, 1, "the proxy runs, its caller built, and no other took the key");
	assert.ok(!f.stages().some((s) => s.stage === "ready"));
	fs.writeFileSync(path.join(f.records, "ready-now"), "");
	const later = await f.client({ operation: "which", connectMs: 20_000 }).ack(60_000);
	assert.equal(later.ending.ending, "answered");
	assert.equal(later.ending.answer.pid, f.owners()[0], "the same proxy, now welcoming");
});
