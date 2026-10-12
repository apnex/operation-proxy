// client-half - the client half's decisions over links a test drives, on an injected clock (CONTRACT.md, PX5,
// PX6): which of PX6's events decides, by the clock as each is read. Needs no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxyClient } from "@apnex/operation-proxy";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";

const KEY = { application: "a", identity: "b", target: "c" };
const turns = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A connector whose links the test drives: each connect gives a link recording what it was written. */
function drivenConnector({ unsafe = false } = {}) {
	const links = [];
	return {
		links,
		launches: 0,
		connector: {
			async connect(handlers) {
				if (unsafe) return { kind: "unsafe" };
				const link = {
					handlers, written: [], open: true, writable: true,
					write(message) { if (!link.writable) return false; link.written.push(message); return true; },
					close() { if (!link.open) return; link.open = false; queueMicrotask(() => handlers.closed()); },
					hold() {},
				};
				links.push(link);
				return { kind: "connected", link };
			},
			launch() { this.launches++; },
		},
	};
}

function client(connector, clock, hopAllowanceMs) {
	return createProxyClient({ key: KEY, connector, clock, identities: machineIdentities, ...(hopAllowanceMs === undefined ? {} : { hopAllowanceMs }) });
}

const call = (c, extra = {}) => c.invoke({ host: "h", service: "s", operation: "o", input: 1, bound: 1000, ...extra });
const welcome = { operationProxy: 1, type: "welcome" };
const answered = (invoke) => ({ operationProxy: 1, type: "end", request: invoke.request, ending: { ending: "answered", invocation: invoke.invocation, attempt: `${invoke.invocation}.0000abcd`, operation: invoke.operation, answer: "yes" } });

test("an end read exactly at the client half's deadline, before its timer runs, is discarded: hop-stalled", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const pending = call(client(d.connector, clock));
	await turns();
	d.links[0].handlers.message(welcome);
	await turns();
	const invoke = d.links[0].written[1];
	clock.move(1000);
	d.links[0].handlers.message(answered(invoke));
	const ending = await pending;
	assert.deepEqual([ending.ending, ending.reason], ["unknown", "hop-stalled"]);
});

test("an end read just before the deadline is taken unchanged", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const pending = call(client(d.connector, clock));
	await turns();
	d.links[0].handlers.message(welcome);
	await turns();
	const invoke = d.links[0].written[1];
	clock.move(999.999999);
	d.links[0].handlers.message(answered(invoke));
	assert.equal((await pending).answer, "yes");
});

test("a welcome or a refusal observed at or after the deadline comes late: proxy-unreachable, nothing written", async () => {
	for (const late of [welcome, { operationProxy: 1, type: "refused", code: "key-mismatch" }]) {
		const clock = createManualHopClock();
		const d = drivenConnector();
		const pending = call(client(d.connector, clock));
		await turns();
		clock.move(1000);
		d.links[0].handlers.message(late);
		const ending = await pending;
		assert.equal(ending.proxyCode, "proxy-unreachable", late.type);
		assert.deepEqual(d.links[0].written.map((m) => m.type), ["hello"]);
	}
});

test("a connection that can no longer be written to when the invocation is written is no proxy: the client half connects again, and nothing of it was written there", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	assert.equal(await (async () => { const p = c.prepare({ timeMs: 1000 }); await turns(); d.links[0].handlers.message(welcome); return p; })(), "ready");
	d.links[0].writable = false;
	const pending = call(c);
	await turns();
	assert.equal(d.links.length, 2, "connected again");
	d.links[1].handlers.message(welcome);
	await turns();
	const invoke = d.links[1].written[1];
	assert.equal(invoke.type, "invoke");
	d.links[1].handlers.message(answered(invoke));
	assert.equal((await pending).answer, "yes");
});

test("an unsafe runtime directory ends not-delivered with runtime-dir-unsafe at once; preparing too", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector({ unsafe: true });
	const c = client(d.connector, clock);
	const ending = await call(c, { repeat: true });
	assert.deepEqual([ending.ending, ending.proxyCode, ending.agpCode, ending.attempt, ending.earlierAttemptsUncertain], ["not-delivered", "runtime-dir-unsafe", null, null, true]);
	assert.equal((await c.prepare({ timeMs: 1000 })).proxyCode, "runtime-dir-unsafe");
	assert.equal(d.launches, 0);
});

test("prepare: ready at once when already prepared even with its deadline past; a deadline already past otherwise times out at once; an abort stops it", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	assert.equal((await c.prepare({ timeMs: 0, invocation: "1791540000000-0123456789abcdef", operation: "o" })).proxyCode, "proxy-unreachable");
	const controller = new AbortController();
	const aborted = c.prepare({ timeMs: 1000, signal: controller.signal });
	controller.abort(new Error("interrupted"));
	await assert.rejects(aborted, /interrupted/);
	const p = c.prepare({ timeMs: 1000 });
	await turns();
	d.links.at(-1).handlers.message(welcome);
	assert.equal(await p, "ready");
	assert.equal(await c.prepare({ timeMs: -5 }), "ready");
	assert.throws(() => c.prepare({ timeMs: Number.NaN }), TypeError);
});

test("an abort given while preparing crosses with the invoke as aborted, and one given after writing is relayed; neither ends the invocation", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	const before = new AbortController();
	const first = call(c, { signal: before.signal });
	await turns();
	before.abort();
	d.links[0].handlers.message(welcome);
	await turns();
	const invoke = d.links[0].written[1];
	assert.equal(invoke.aborted, true);
	const after = new AbortController();
	const second = call(c, { signal: after.signal });
	await turns();
	after.abort();
	assert.deepEqual(d.links[0].written.at(-1), { operationProxy: 1, type: "abort", request: 2 });
	d.links[0].handlers.message(answered(invoke));
	d.links[0].handlers.message(answered(d.links[0].written[2]));
	assert.equal((await first).answer, "yes");
	assert.equal((await second).answer, "yes");
});
