// client-half - the client half's decisions over links a test drives, on an injected clock (CONTRACT.md, PX5,
// PX6): which of PX6's events decides, by the clock as each is read; and that a connection holds its process
// only while an invocation written on it waits, so a short-lived process ends once its endings are read.
// Needs no socket.
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
					holds: [],
					hold(keep) { link.holds.push(keep); },
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

/** Prepares a client half over a driven connector and gives its welcomed link. */
async function welcomed(c, d) {
	const p = c.prepare({ timeMs: 1000 });
	await turns();
	d.links.at(-1).handlers.message(welcome);
	assert.equal(await p, "ready");
	return d.links.at(-1);
}

/** Whether a link last asked to hold its process: true while held, false once let go. */
const holding = (link) => link.holds.at(-1);

test("one normal ending releases the connection's hold on its process, which a welcomed connection without invocations never had", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	const link = await welcomed(c, d);
	assert.equal(holding(link), false, "welcomed and idle: not held");
	const pending = call(c);
	await turns();
	assert.equal(holding(link), true, "held while the invocation waits");
	link.handlers.message(answered(link.written[1]));
	assert.equal((await pending).answer, "yes");
	assert.equal(holding(link), false, "let go once its ending is read");
	assert.deepEqual(link.holds.slice(-2), [true, false]);
	assert.equal(link.open, true, "the connection stays open for the next invocation");
});

test("several normal endings read out of order release the hold only when the last is read, once", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	const link = await welcomed(c, d);
	const pending = [call(c, { input: 1 }), call(c, { input: 2 }), call(c, { input: 3 })];
	await turns();
	const invokes = link.written.filter((m) => m.type === "invoke");
	assert.equal(invokes.length, 3);
	const before = link.holds.length;
	for (const i of [2, 0]) {
		link.handlers.message(answered(invokes[i]));
		await turns();
		assert.equal(holding(link), true, `held while another waits, after the end of request ${invokes[i].request}`);
	}
	link.handlers.message(answered(invokes[1]));
	for (const p of pending) assert.equal((await p).answer, "yes");
	assert.equal(holding(link), false);
	assert.deepEqual(link.holds.slice(before).filter((h) => h === false), [false], "let go exactly once");
	assert.equal(link.open, true);
});

test("an invocation ended at its deadline releases the hold; its later end is a late end, discarded, and the connection carries the next", async () => {
	const clock = createManualHopClock();
	const d = drivenConnector();
	const c = client(d.connector, clock);
	const link = await welcomed(c, d);
	const timedOut = call(c, { bound: 100 });
	const waiting = call(c, { bound: 10_000 });
	await turns();
	const [first, second] = link.written.filter((m) => m.type === "invoke");
	clock.advance(100);
	const stalled = await timedOut;
	assert.deepEqual([stalled.ending, stalled.reason], ["unknown", "hop-stalled"]);
	assert.equal(holding(link), true, "still held: another invocation waits");
	link.handlers.message(answered(first));
	await turns();
	assert.equal(link.open, true, "a late end for a request written on the connection fits the table");
	assert.equal(holding(link), true, "the late end changes nothing");
	link.handlers.message(answered(second));
	assert.equal((await waiting).answer, "yes");
	assert.equal(holding(link), false, "let go once the last waiting ending is read");
	const alone = call(c, { bound: 100 });
	await turns();
	const third = link.written.filter((m) => m.type === "invoke")[2];
	assert.equal(holding(link), true);
	clock.advance(100);
	assert.equal((await alone).reason, "hop-stalled");
	assert.equal(holding(link), false, "an invocation ended by its deadline alone lets go");
	link.handlers.message(answered(third));
	await turns();
	assert.equal(holding(link), false, "and its late end changes nothing");
	assert.equal(link.open, true);
	link.handlers.message(answered(third));
	await turns();
	assert.equal(link.open, false, "a second end for the same request is for a request no longer written: it breaks the table");
});
