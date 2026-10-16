// proxied-invocation - a short-lived process invokes a named operation through the proxy and gets exactly one
// ending, within the bound it chose, kept across the hop (CONTRACT.md, PX4, PX5, PX6, and PX10's held and
// stopped hops; zorg's E17, D48).
//
// Needs Unix sockets throughout: most cases run the client half and the proxy half in this process over a real
// channel socket, on a manual hop clock, the proxy's caller operation-call's own over AGP's production
// in-process carrier, every direct call the proxy makes recorded - its moment, bound and abort - and the
// ending checked against it. The cases marked "(processes)" also run the proxy as a real child process. Three
// PX4 cases instead join the public halves by a channel that delivers each message within the write sending it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createCaller } from "@apnex/operation-call";
import { callClockOf, createProxyClient, createProxyHalf } from "@apnex/operation-proxy";
import { messageBytes, writeRequest } from "@apnex/operation-call/message-format";
import { connectChannel } from "../../dist/machine-channel-adapter.js";
import { machineClock, machineIdentities } from "../../dist/machine-clock-adapter.js";
import { ns, openCase, rawConnection, rawProxy, settle, until, watch, withCase } from "../support/case-hop.js";
import { KEY } from "../support/hop.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";
import { openTopology } from "../support/topology.js";
import { fixture, PROXY_MAIN, sleep, waitFor } from "../support/processes.js";

const LINE = 16785408;
const NOT_SENDABLE = { part: "operation-call", code: "not-sendable", what: "The request would nest more than 30 levels, hold an integer more than 9007199254740991 from zero, or exceed 16777216 bytes as JSON.", why: "AGP carries no such message to any peer, so the request was not sent.", fix: "Make the input shallower, keep every integer within 9007199254740991 of zero, or send less, then call again.", details: {} };
const REFUSAL = { part: "fixture-store", code: "revision-moved", what: "The revision moved.", why: "Another write landed first.", fix: "Read again, then write.", details: {} };

/** Asserts the client half's ending is exactly the ending of the direct call the proxy made (D48). */
function sameAsDirect(ending, record, what) {
	assert.ok(record?.ending, `${what}: the proxy made its call, and it ended`);
	assert.deepEqual(ending, record.ending, `${what}: the ending of the direct call the proxy made, unchanged`);
	assert.ok(Object.isFrozen(ending), `${what}: frozen`);
}

// ---------------------------------------------------------------------------------------------------------
// PX4 - the channel's messages.

test("PX4: the whole wire record of two calls alike but for their service, reaching two endpoints over one proxy", async () => {
	await withCase({}, async (c) => {
		const one = await c.ended({ operation: "which", input: { n: 1 } });
		const two = await c.ended({ operation: "which", input: { n: 1 }, service: "other" });
		assert.equal(one.answer.service, "fixture");
		assert.equal(two.answer.service, "other");
		assert.deepEqual(c.a.runs.map((r) => [r.service, r.operation, r.input]), [["fixture", "which", { n: 1 }], ["other", "which", { n: 1 }]]);
		const deadline = c.deadline(0, 1000, 50);
		assert.deepEqual(c.wire, [
			{ to: "proxy", message: { operationProxy: 1, type: "hello", key: { application: KEY.application, identity: KEY.identity, target: KEY.target } } },
			{ to: "client", message: { operationProxy: 1, type: "welcome" } },
			{ to: "proxy", message: { operationProxy: 1, type: "invoke", request: 1, invocation: one.invocation, host: "host-a", service: "fixture", operation: "which", input: { n: 1 }, deadline, repeat: false, aborted: false } },
			{ to: "client", message: { operationProxy: 1, type: "end", request: 1, ending: one } },
			{ to: "proxy", message: { operationProxy: 1, type: "invoke", request: 2, invocation: two.invocation, host: "host-a", service: "other", operation: "which", input: { n: 1 }, deadline, repeat: false, aborted: false } },
			{ to: "client", message: { operationProxy: 1, type: "end", request: 2, ending: two } },
		]);
		assert.deepEqual(c.calls.map((r) => [r.call.service, r.call.operation, r.bound, r.at, r.call.invocation, r.call.repeat]), [
			["fixture", "which", 950, c.clock.start, one.invocation, false], ["other", "which", 950, c.clock.start, two.invocation, false],
		]);
		sameAsDirect(one, c.calls[0], "the call to fixture");
		sameAsDirect(two, c.calls[1], "the call to other");
	});
});

test("PX4: the client sends hello first and nothing else until welcome, which the proxy sends only once its caller is ready by the application's own test", async () => {
	const readiness = Promise.withResolvers();
	await withCase({ readiness: readiness.promise }, async (c) => {
		const call = watch(c.call({ operation: "echo", input: "after welcome" }));
		await until(() => c.wire.length === 1, "the hello");
		await settle(60);
		assert.deepEqual(c.wire.map((w) => w.message.type), ["hello"], "only hello, and no welcome before the caller is ready");
		assert.ok(!call.settled());
		readiness.resolve();
		await until(call.settled, "the ending once welcomed");
		assert.equal(call.value().ending, "answered");
		assert.deepEqual(c.wire.map((w) => w.message.type), ["hello", "welcome", "invoke", "end"]);
	});
});

test("PX4: a hello with a key other than the proxy's is refused key-mismatch, and a version other than 1 is refused version, each then closed", async () => {
	await withCase({}, async (c) => {
		const other = await rawConnection(c.hop.socketPath);
		other.send({ operationProxy: 1, type: "hello", key: { ...KEY, identity: "mallory" } });
		await until(other.closed, "the connection closed");
		assert.deepEqual(other.lines, [{ operationProxy: 1, type: "refused", code: "key-mismatch" }]);
		const later = await rawConnection(c.hop.socketPath);
		later.send({ operationProxy: 2, type: "hello", key: KEY });
		await until(later.closed, "the connection closed");
		assert.deepEqual(later.lines, [{ operationProxy: 1, type: "refused", code: "version" }]);
		// Through a client half with another key: not delivered, with the refusal's code as its proxy code.
		const stranger = createProxyClient({ key: { ...KEY, target: "another target" }, clock: c.clock, identities: machineIdentities, connector: { connect: (h) => connectChannel(c.hop.socketPath, h), launch: () => undefined } });
		const ending = watch(stranger.invoke({ host: "host-a", service: "fixture", operation: "echo", input: 1, bound: 1000, repeat: true }));
		await until(ending.settled, "the refusal");
		assert.deepEqual(ending.value(), { ending: "not-delivered", invocation: ending.value().invocation, attempt: null, operation: "echo", agpCode: null, proxyCode: "key-mismatch", earlierAttemptsUncertain: true });
		assert.equal(c.calls.length, 0, "nothing was handed on");
	});
});

test("PX4: one connection carries invocations at once, their ends in any order paired by request, and an abort for a request already ended is ignored", async () => {
	await withCase({}, async (c) => {
		const first = watch(c.call({ operation: "hold", input: 1, bound: 10_000 }));
		const second = watch(c.call({ operation: "hold", input: 2, bound: 10_000 }));
		await until(() => c.a.holds.length === 2, "both in flight at once");
		c.a.holds[1].release();
		await until(second.settled, "the second");
		assert.ok(!first.settled(), "the first still waits");
		c.a.holds[0].release();
		await until(first.settled, "the first");
		assert.deepEqual(first.value().answer.input, 1);
		assert.deepEqual(second.value().answer.input, 2);
		assert.deepEqual(c.hop.sent("end").map((e) => e.request), [2, 1], "the ends arrived in the other order, paired by request");
		const raw = await rawConnection(c.hop.socketPath);
		raw.send({ operationProxy: 1, type: "hello", key: KEY });
		raw.send({ operationProxy: 1, type: "invoke", request: 1, invocation: "1791540000000-0123456789abcdef", host: "host-a", service: "fixture", operation: "echo", input: "x", deadline: c.deadline(0, 1000, 50), repeat: false, aborted: false });
		await until(() => raw.lines.length === 2, "welcome and end");
		raw.send({ operationProxy: 1, type: "abort", request: 1 });
		raw.send({ operationProxy: 1, type: "abort", request: 99 });
		raw.send({ operationProxy: 1, type: "invoke", request: 2, invocation: "1791540000000-0123456789abcdee", host: "host-a", service: "fixture", operation: "echo", input: "y", deadline: c.deadline(0, 1000, 50), repeat: false, aborted: false });
		await until(() => raw.lines.length === 3, "the next end on the same connection");
		assert.equal(raw.lines[2].ending.answer, "y");
		assert.ok(!raw.closed(), "the aborts changed nothing and closed nothing");
		raw.end();
	});
});

/** An invoke for a raw connection, with fields given. */
function rawInvoke(c, fields = {}) {
	return { operationProxy: 1, type: "invoke", request: 1, invocation: "1791540000000-0123456789abcdef", host: "host-a", service: "fixture", operation: "echo", input: "x", deadline: c.deadline(0, 1000, 50), repeat: false, aborted: false, ...fields };
}

test("PX4: a line of exactly 16785408 bytes with its newline is read; one byte longer, one that does not parse, and one that breaks the table each close the connection", { timeout: 60_000 }, async () => {
	await withCase({}, async (c) => {
		const sized = (bytes) => {
			const empty = JSON.stringify(rawInvoke(c, { input: "" }));
			return `${JSON.stringify(rawInvoke(c, { input: "x".repeat(bytes - 1 - Buffer.byteLength(empty)) }))}\n`;
		};
		const exact = await rawConnection(c.hop.socketPath);
		exact.send({ operationProxy: 1, type: "hello", key: KEY });
		const line = sized(LINE);
		assert.equal(Buffer.byteLength(line), LINE);
		exact.write(line);
		await until(() => exact.lines.length === 2, "the end of the longest line's invocation", 30_000);
		assert.equal(exact.lines[1].type, "end", "read and handed on");
		assert.deepEqual([exact.lines[1].ending.ending, exact.lines[1].ending.refusal?.code], ["refused", "not-sendable"], "the call layer refuses its request, larger than it sends");
		assert.ok(!exact.closed());
		exact.end();
		const longer = await rawConnection(c.hop.socketPath);
		longer.send({ operationProxy: 1, type: "hello", key: KEY });
		longer.write(sized(LINE + 1));
		await until(longer.closed, "the connection closed", 30_000);
		assert.deepEqual(longer.lines.map((l) => l.type), ["welcome"]);
		const breaking = [
			["a line that does not parse", "{\"operationProxy\":1,\n"],
			["a line that is not UTF-8", Buffer.from([0x7b, 0xff, 0x7d, 0x0a])],
			["an empty line", "\n"],
			["an unknown type", { operationProxy: 1, type: "ping" }],
			["an invoke missing a field", (() => { const m = rawInvoke(c); delete m.aborted; return m; })()],
			["an invoke with a field more", rawInvoke(c, { extra: true })],
			["a request number of 0", rawInvoke(c, { request: 0 })],
			["a deadline as a number", rawInvoke(c, { deadline: 1 })],
			["a service breaking the name pattern", rawInvoke(c, { service: "Fixture" })],
			["an invocation not as EM11 writes it", rawInvoke(c, { invocation: "x" })],
			["a second hello", { operationProxy: 1, type: "hello", key: KEY }],
			["a request number used twice", "twice"],
		];
		for (const [what, bad] of breaking) {
			const raw = await rawConnection(c.hop.socketPath);
			raw.send({ operationProxy: 1, type: "hello", key: KEY });
			await until(() => raw.lines.length === 1, "welcome");
			if (bad === "twice") {
				raw.send(rawInvoke(c, { operation: "hold" }));
				await until(() => c.a.holds.length > 0, "the first in flight");
				raw.send(rawInvoke(c, { operation: "hold" }));
			} else if (typeof bad === "string" || Buffer.isBuffer(bad)) raw.write(bad);
			else raw.send(bad);
			await until(raw.closed, `${what} closes the connection`);
		}
		for (const [what, first] of [["an invoke before hello", rawInvoke(c)], ["a hello whose key lacks its target", { operationProxy: 1, type: "hello", key: { application: KEY.application, identity: KEY.identity } }]]) {
			const raw = await rawConnection(c.hop.socketPath);
			raw.send(first);
			await until(raw.closed, `${what} closes the connection`);
			assert.deepEqual(raw.lines, [], `${what}: nothing written back`);
		}
	});
});

test("PX4, PX6: an end the proxy writes that breaks the table closes the channel, and the invocation written ends unknown with proxy-lost", async () => {
	const outbound = (message, write) => {
		if (message.type !== "end") return write();
		message.ending = { ...message.ending, extra: 1 };
		write();
	};
	await withCase({ outbound }, async (c) => {
		const ending = await c.ended({ operation: "echo", input: 1 });
		assert.deepEqual(ending, { ending: "unknown", invocation: ending.invocation, attempt: null, operation: "echo", reason: "proxy-lost", agpCode: null, deliveryReport: null });
		assert.equal(c.calls.length, 1);
	});
});

/** The ending the client half gives an invocation written on a channel that closed or broke the table (PX6). */
const proxyLost = (ending) => ({ ending: "unknown", invocation: ending.invocation, attempt: null, operation: ending.operation, reason: "proxy-lost", agpCode: null, deliveryReport: null });

/** Raw JSON text nesting `levels` arrays around 0. */
const nestedText = (levels) => `${"[".repeat(levels)}0${"]".repeat(levels)}`;

test("PX4, PX6: an end whose answer or refusal breaks the call layer's JSON, number or depth rules, read from the real wire, breaks the table: the channel closes and the invocation ends unknown with proxy-lost; values at the rules' edges are taken", { timeout: 60_000 }, async () => {
	// Raw text a JSON encoder never writes: what a broken or hostile peer can put on the channel.
	const answered = (invoke, answer) => `{"ending":"answered","invocation":"${invoke.invocation}","attempt":"${invoke.invocation}.0000abcd","operation":"${invoke.operation}","answer":${answer}}`;
	const refused = (invoke, details) => `{"ending":"refused","invocation":"${invoke.invocation}","attempt":"${invoke.invocation}.0000abcd","operation":"${invoke.operation}","refusal":{"part":"p","code":"c","what":"w","why":"y","fix":"f","details":${details}}}`;
	const breaking = [
		["an infinite answer", (i) => answered(i, "1e400")],
		["a negative infinite answer", (i) => answered(i, "-1e400")],
		["an infinite number nested in the answer", (i) => answered(i, '{"a":[1,{"b":1e400}]}')],
		["an unsafe integer, one more than 9007199254740991", (i) => answered(i, "9007199254740992")],
		["an unsafe negative integer", (i) => answered(i, "-9007199254740992")],
		["an unsafe integer nested in the answer", (i) => answered(i, '[0,{"n":9007199254740993}]')],
		["a large number that is an integer beyond the safe range", (i) => answered(i, "1e300")],
		["an answer of 30 levels, its end message 31", (i) => answered(i, nestedText(30))],
		["an answer of 100000 levels", (i) => answered(i, nestedText(100_000))],
		["a refusal whose details hold an infinite number", (i) => refused(i, '{"n":1e400}')],
		["a refusal whose details hold an unsafe integer", (i) => refused(i, '{"n":[9007199254740992]}')],
		["a refusal whose details nest 29 levels, its end message 31", (i) => refused(i, `{"n":${nestedText(28)}}`)],
	];
	const taken = [
		["the largest safe integer", (i) => answered(i, "9007199254740991"), 9007199254740991],
		["the smallest safe integer", (i) => answered(i, "-9007199254740991"), -9007199254740991],
		["a fraction", (i) => answered(i, "1e-300"), 1e-300],
		["an answer of 29 levels, its end message 30", (i) => answered(i, nestedText(29)), JSON.parse(nestedText(29))],
	];
	const all = [...breaking, ...taken];
	const proxy = await rawProxy((invoke, line) => line(`{"operationProxy":1,"type":"end","request":${invoke.request},"ending":${all[invoke.input][1](invoke)}}`));
	try {
		for (const [n, [what]] of all.entries()) {
			const client = proxy.client(machineClock);
			const closes = proxy.closes();
			const ending = await client.invoke({ host: "host-a", service: "fixture", operation: "echo", input: n, bound: 10_000 });
			if (n < breaking.length) {
				assert.deepEqual(ending, proxyLost(ending), what);
				await until(() => proxy.closes() === closes + 1, `${what}: the channel closed`);
			} else {
				assert.equal(ending.ending, "answered", what);
				assert.deepEqual(ending.answer, all[n][2], what);
				assert.ok(Object.isFrozen(ending), `${what}: frozen`);
				client.close();
				await until(() => proxy.closes() === closes + 1, `${what}: closed by the test`);
			}
		}
	} finally {
		await proxy.close();
	}
});

test("PX4, PX6: an end for a request the client never wrote, or naming another invocation or another operation, breaks the table: the channel closes and the invocation written ends unknown with proxy-lost", async () => {
	const ends = [
		["a request the client never wrote", (i) => ({ request: i.request + 1, ending: { ending: "answered", invocation: i.invocation, attempt: `${i.invocation}.0000abcd`, operation: i.operation, answer: 1 } })],
		["another invocation", (i) => ({ request: i.request, ending: { ending: "answered", invocation: "1791540000000-0123456789abcdee", attempt: "1791540000000-0123456789abcdee.0000abcd", operation: i.operation, answer: 1 } })],
		["an attempt of another invocation", (i) => ({ request: i.request, ending: { ending: "answered", invocation: i.invocation, attempt: "1791540000000-0123456789abcdee.0000abcd", operation: i.operation, answer: 1 } })],
		["another operation", (i) => ({ request: i.request, ending: { ending: "answered", invocation: i.invocation, attempt: `${i.invocation}.0000abcd`, operation: "which", answer: 1 } })],
	];
	const proxy = await rawProxy((invoke, line) => line(JSON.stringify({ operationProxy: 1, type: "end", ...ends[invoke.input][1](invoke) })));
	try {
		for (const [n, [what]] of ends.entries()) {
			const closes = proxy.closes();
			const ending = await proxy.client(machineClock).invoke({ host: "host-a", service: "fixture", operation: "echo", input: n, bound: 10_000 });
			assert.deepEqual(ending, proxyLost(ending), what);
			await until(() => proxy.closes() === closes + 1, `${what}: the channel closed`);
		}
	} finally {
		await proxy.close();
	}
});

test("PX4: a client message after hello while welcome is held breaks the table: the proxy closes the connection, never welcomes it, and hands nothing on", async () => {
	const readiness = Promise.withResolvers();
	await withCase({ readiness: readiness.promise }, async (c) => {
		const waiting = [];
		for (const next of [rawInvoke(c), { operationProxy: 1, type: "abort", request: 1 }, { operationProxy: 1, type: "hello", key: KEY }]) {
			const raw = await rawConnection(c.hop.socketPath);
			raw.send({ operationProxy: 1, type: "hello", key: KEY });
			await until(() => c.hop.half.connections() === waiting.length + 1, "the hello read, its welcome held");
			raw.send(next);
			await until(raw.closed, `a ${next.type} after hello, before welcome, closes the connection`);
			assert.deepEqual(raw.lines, [], `a ${next.type}: nothing written back`);
			await until(() => c.hop.half.connections() === waiting.length, "the connection gone from the proxy");
		}
		const patient = await rawConnection(c.hop.socketPath);
		patient.send({ operationProxy: 1, type: "hello", key: KEY });
		await until(() => c.hop.half.connections() === 1, "a client that waits");
		readiness.resolve();
		await until(() => patient.lines.length === 1, "its welcome");
		assert.deepEqual(patient.lines, [{ operationProxy: 1, type: "welcome" }], "a client that sent nothing more is welcomed once the caller is ready");
		assert.equal(c.calls.length, 0, "nothing was handed on");
		patient.end();
	});
});

/**
 * The public halves joined by a channel that delivers each message synchronously, inside the write that sends it,
 * as a channel over any carrier may (PX1, PX4). `duringInvoke(n)` is asked, as the client half's nth invoke is
 * written, whether to move the clock first (`move`, in ms), to close the connection instead of writing it
 * (`closeUnwritten`: the write then returns false), or to close it once written (`closeWritten`). The proxy's
 * caller holds each call until the test answers it. Each link records its holds and the invokes the proxy read.
 */
function synchronousChannel(duringInvoke = () => ({})) {
	const clock = createManualHopClock();
	const calls = [];
	const caller = { invoke: (call) => new Promise((resolve) => calls.push({ call, answer: () => resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000000`, operation: call.operation, answer: call.input }) })) };
	const half = createProxyHalf({ key: KEY, clock, idleMs: 1000, onIdle: () => undefined });
	half.ready(caller, callClockOf(clock));
	const links = [];
	let invokes = 0;
	const client = createProxyClient({
		key: KEY, clock, identities: machineIdentities,
		connector: {
			async connect(clientHandlers) {
				let open = true;
				const record = { holds: [], invokesRead: 0 };
				links.push(record);
				const wire = (m) => JSON.parse(JSON.stringify(m));
				let proxyHandlers;
				const close = () => {
					if (!open) return;
					open = false;
					proxyHandlers.closed();
					clientHandlers.closed();
				};
				proxyHandlers = half.accept({ write: (m) => { if (!open) return false; clientHandlers.message(wire(m)); return true; }, close, hold: () => undefined });
				return {
					kind: "connected",
					link: {
						write(m) {
							if (!open) return false;
							if (m.type !== "invoke") {
								proxyHandlers.message(wire(m));
								return true;
							}
							const plan = duringInvoke(++invokes);
							if (plan.move !== undefined) clock.move(plan.move);
							if (plan.closeUnwritten) {
								close();
								return false;
							}
							record.invokesRead++;
							proxyHandlers.message(wire(m));
							if (plan.closeWritten) close();
							return true;
						},
						hold: (keep) => record.holds.push(keep),
						close,
					},
				};
			},
			launch: () => undefined,
		},
	});
	/** Each ending, and how many times its promise settled. */
	const invoke = (call) => {
		const outcome = { settled: 0, ending: undefined };
		outcome.done = client.invoke({ host: "host-a", service: "fixture", operation: "echo", input: null, ...call }).then((ending) => { outcome.settled++; outcome.ending = ending; return ending; });
		return outcome;
	};
	return { clock, half, client, calls, links, invoke, close: () => { client.close(); half.stopIdle(); } };
}

/** Whether a link last asked to hold its process: true while held, false once let go. */
const holding = (record) => record.holds.at(-1);

test("PX4: over a channel delivering synchronously, a deadline-passed refusal read during the invoke's own write ends it once; the link is then not held, and the count of waiting invocations is not below zero: the next invocation holds it and lets it go", { timeout: 30_000 }, async () => {
	// Bound 2 ms, allowance 1 ms: 0.25 ms of outbound transit leaves the proxy under 1 ms, so it refuses at once.
	const h = synchronousChannel((n) => n === 1 ? { move: 0.25 } : {});
	try {
		const refused = h.invoke({ bound: 2 });
		await refused.done;
		await settle();
		assert.equal(refused.ending.ending, "not-delivered");
		assert.equal(refused.ending.proxyCode, "deadline-passed");
		assert.equal(refused.settled, 1, "settled once");
		assert.equal(h.calls.length, 0, "the proxy's caller was not called");
		assert.equal(h.half.inFlight(), 0);
		assert.equal(h.links.length, 1);
		assert.equal(holding(h.links[0]), false, "after its ending the link is not held");
		const next = h.invoke({ bound: 1000, input: { n: 2 } });
		await until(() => h.calls.length === 1, "the next call handed on");
		assert.equal(holding(h.links[0]), true, "held while the next invocation waits: the count was not below zero");
		h.calls[0].answer();
		await next.done;
		await settle();
		assert.deepEqual(next.ending.answer, { n: 2 });
		assert.equal(next.settled, 1);
		assert.equal(holding(h.links[0]), false, "let go after the last ending");
		assert.equal(h.links.length, 1, "one connection carried both");
	} finally {
		h.close();
	}
});

test("PX4, PX6: over a channel delivering synchronously, a close reported during the invoke's write: once written, the invocation ends unknown with proxy-lost, once; nothing written, it is written on the next connection and answered, once; afterwards no link is held", { timeout: 30_000 }, async () => {
	{
		const h = synchronousChannel((n) => n === 1 ? { closeWritten: true } : {});
		try {
			const lost = h.invoke({ bound: 1000, input: { n: 1 } });
			await lost.done;
			await settle();
			assert.equal(lost.ending.ending, "unknown");
			assert.equal(lost.ending.reason, "proxy-lost");
			assert.equal(lost.settled, 1, "settled once");
			assert.equal(h.links[0].invokesRead, 1, "written once, and not again");
			assert.equal(holding(h.links[0]), false, "the closed link is not held");
			// The proxy's call, its connection gone, ends later; its ending is dropped and changes nothing.
			h.calls[0].answer();
			await settle();
			assert.equal(lost.settled, 1);
			assert.equal(lost.ending.reason, "proxy-lost");
			const next = h.invoke({ bound: 1000, input: { n: 2 } });
			await until(() => h.calls.length === 2, "the next call handed on, over a new connection");
			assert.equal(h.links.length, 2);
			assert.equal(holding(h.links[1]), true);
			h.calls[1].answer();
			await next.done;
			await settle();
			assert.deepEqual(next.ending.answer, { n: 2 });
			assert.equal(holding(h.links[1]), false, "let go after the last ending");
			assert.equal(holding(h.links[0]), false);
		} finally {
			h.close();
		}
	}
	{
		const h = synchronousChannel((n) => n === 1 ? { closeUnwritten: true } : {});
		try {
			const answered = h.invoke({ bound: 1000, input: { n: 3 } });
			await until(() => h.calls.length === 1, "the call handed on, over a new connection");
			assert.equal(h.links.length, 2, "nothing written on the first connection, so the invocation went on a new one");
			assert.equal(h.links[0].invokesRead, 0);
			assert.equal(holding(h.links[0]), false, "the closed link is not held");
			assert.equal(holding(h.links[1]), true, "held while it waits");
			h.calls[0].answer();
			await answered.done;
			await settle();
			assert.deepEqual(answered.ending.answer, { n: 3 });
			assert.equal(answered.settled, 1, "settled once");
			assert.equal(h.links[1].invokesRead, 1);
			assert.equal(holding(h.links[1]), false, "let go after the last ending");
		} finally {
			h.close();
		}
	}
});

test("PX4: over a channel delivering synchronously, an invocation refused during its own write beside another still waiting leaves the link held for the other; the other's ending lets it go exactly once, and the next invocation holds it again", { timeout: 30_000 }, async () => {
	const h = synchronousChannel((n) => n === 2 ? { move: 0.25 } : {});
	try {
		const waiting = h.invoke({ bound: 1000, input: { n: 1 } });
		await until(() => h.calls.length === 1, "the first call handed on");
		const before = h.links[0].holds.length;
		const refused = h.invoke({ bound: 2 });
		await refused.done;
		await settle();
		assert.equal(refused.ending.proxyCode, "deadline-passed");
		assert.equal(refused.settled, 1);
		assert.equal(holding(h.links[0]), true, "still held: the first invocation waits");
		h.calls[0].answer();
		await waiting.done;
		await settle();
		assert.deepEqual(waiting.ending.answer, { n: 1 });
		assert.equal(waiting.settled, 1);
		assert.equal(holding(h.links[0]), false, "let go after the last ending");
		assert.deepEqual(h.links[0].holds.slice(before).filter((keep) => keep === false), [false], "let go exactly once");
		const next = h.invoke({ bound: 1000, input: { n: 3 } });
		await until(() => h.calls.length === 2, "the next call handed on");
		assert.equal(holding(h.links[0]), true, "the next invocation holds it: the count was not below zero");
		h.calls[1].answer();
		await next.done;
		await settle();
		assert.equal(holding(h.links[0]), false);
		assert.equal(h.half.inFlight(), 0);
	} finally {
		h.close();
	}
});

// ---------------------------------------------------------------------------------------------------------
// PX5 - preparing, the bound, and when a proxied call is made.

/** An input string making the request message exactly `bytes` bytes for an invocation of `echo`. */
function inputOfRequestBytes(bytes) {
	const overhead = messageBytes(writeRequest({ invocation: "0000000000000-0000000000000000", attempt: "0000000000000-0000000000000000.00000000", operation: "echo" }, ""));
	return "x".repeat(bytes - overhead);
}

test("PX5: a request message of exactly 16777216 bytes is written and handed on, one byte more is refused not-sendable with nothing written, another call in flight and a small one after each", { timeout: 120_000 }, async () => {
	await withCase({}, async (c) => {
		const inFlight = watch(c.call({ operation: "hold", bound: 100_000 }));
		await until(() => c.a.holds.length === 1, "another call in flight");
		const exact = await c.ended({ operation: "echo", input: inputOfRequestBytes(16777216), bound: 100_000 });
		assert.deepEqual([exact.ending, exact.agpCode, exact.proxyCode], ["not-delivered", "MESSAGE_TOO_LARGE", null], "handed on, and refused by AGP as a direct call is");
		sameAsDirect(exact, c.calls[1], "the largest request");
		assert.equal((await c.ended({ operation: "echo", input: "small" })).answer, "small", "a small call after it");
		const invokes = c.invokes().length;
		const over = await c.ended({ operation: "echo", input: inputOfRequestBytes(16777217), bound: 100_000 });
		assert.equal(over.ending, "refused");
		assert.deepEqual(over.refusal, { part: "operation-call", code: "not-sendable", what: "The request would nest more than 30 levels, hold an integer more than 9007199254740991 from zero, or exceed 16777216 bytes as JSON.", why: "AGP carries no such message to any peer, so the request was not sent.", fix: "Make the input shallower, keep every integer within 9007199254740991 of zero, or send less, then call again.", details: {} });
		assert.ok(over.attempt.startsWith(`${over.invocation}.`), "refused under an attempt identity, as the call layer refuses");
		assert.equal(c.invokes().length, invokes, "nothing of it was written");
		assert.equal((await c.ended({ operation: "echo", input: "small again" })).answer, "small again", "a small call after it");
		c.a.holds[0].release();
		await until(inFlight.settled, "the call in flight");
		assert.equal(inFlight.value().ending, "answered");
		let deep = 0;
		for (let i = 0; i < 30; i++) deep = [deep];
		assert.equal((await c.ended({ operation: "echo", input: deep })).refusal.code, "not-sendable", "31 levels, refused before writing");
		assert.equal((await c.ended({ operation: "echo", input: 2 ** 60 })).refusal.code, "not-sendable", "an unsafe integer, refused before writing");
		assert.equal(c.invokes().length, invokes + 1, "only the small call after it was written since");
	});
});

test("PX5: a host so long that the invocation would not fit a line is refused not-sendable with nothing written, where the same call made directly meets AGP's own refusal, not delivered", { timeout: 120_000 }, async () => {
	const host = "h".repeat(LINE);
	await withCase({}, async (c) => {
		const ending = await c.ended({ host, operation: "echo", input: {}, bound: 100_000 });
		assert.deepEqual(ending, { ending: "refused", invocation: ending.invocation, attempt: ending.attempt, operation: "echo", refusal: NOT_SENDABLE });
		assert.ok(ending.attempt.startsWith(`${ending.invocation}.`), "refused under an attempt identity, as the call layer refuses");
		assert.equal(c.invokes().length, 0, "nothing of it was written");
		assert.equal(c.calls.length, 0, "and nothing handed on");
		assert.equal((await c.ended({ operation: "echo", input: "after" })).answer, "after", "the client half carries the next call");
	});
	const t = await openTopology();
	const direct = await createCaller({ node: t.sendingNode });
	try {
		const ending = await direct.invoke({ host, service: "fixture", operation: "echo", input: {}, bound: 100_000 });
		assert.equal(ending.ending, "not-delivered", "a direct call is handed to AGP, which refuses it");
		assert.equal(typeof ending.agpCode, "string", "AGP's own code");
		assert.equal(ending.proxyCode, null);
		assert.equal(ending.refusal, undefined, "never the call layer's not-sendable refusal");
	} finally {
		await direct.close();
		await t.close();
	}
});

test("PX5: a hop delayed in each direction: the call is made when the proxy hands it on, its bound the deadline less the proxy's reading, rounded down; a return within the allowance is taken", async () => {
	let hold = true;
	let held;
	const inbound = (value, deliver) => { if (hold && value.type === "invoke") held = deliver; else deliver(); };
	let heldEnd;
	const outbound = (message, write) => { if (message.type === "end") heldEnd = write; else write(); };
	await withCase({ inbound, outbound }, async (c) => {
		const call = watch(c.call({ operation: "echo", input: "late", bound: 1000 }));
		await until(() => held !== undefined, "the invoke in transit");
		hold = false;
		c.clock.advance(7.5);
		held();
		await until(() => heldEnd !== undefined, "the end in transit");
		const record = c.calls[0];
		assert.equal(record.at, c.clock.start + ns(7.5), "made when the proxy handed it on");
		assert.equal(record.bound, 942, "the sooner deadline less the proxy's reading, 942.5 ms, rounded down");
		assert.equal(c.invokes()[0].deadline, c.deadline(0, 1000, 50), "the deadline sent is the client half's less the allowance");
		c.clock.advance(30);
		heldEnd();
		await until(call.settled, "the ending");
		sameAsDirect(call.value(), record, "a hop delayed both ways");
	});
});

test("PX5: preparing that takes part of the bound happens within it, and the deadline sent is still the bound's from the moment of invoking", async () => {
	const readiness = Promise.withResolvers();
	await withCase({ readiness: readiness.promise }, async (c) => {
		const call = watch(c.call({ operation: "echo", input: "prepared late", bound: 1000 }));
		await until(() => c.wire.length === 1, "the hello");
		c.clock.advance(300);
		readiness.resolve();
		await until(call.settled, "the ending");
		assert.equal(c.invokes()[0].deadline, c.deadline(0, 1000, 50));
		assert.equal(c.calls[0].at, c.clock.start + ns(300));
		assert.equal(c.calls[0].bound, 650);
		sameAsDirect(call.value(), c.calls[0], "an invocation prepared within its bound");
	});
});

test("PX5: a find of several pages whose connection is lost between pages prepares again within the next page's bound, the time the find leaves it", async () => {
	await withCase({}, async (c) => {
		const first = await c.ended({ operation: "echo", input: "page 1", bound: 100 });
		assert.equal(first.answer, "page 1");
		c.hop.half.closeAll();
		await settle();
		c.clock.advance(20);
		const second = watch(c.call({ operation: "silent", input: "page 2", bound: 80 }));
		await until(() => c.invokes().length === 2, "the second page written on a new connection");
		assert.deepEqual(c.wire.filter((w) => w.message.type === "hello").length, 2, "prepared again");
		assert.equal(c.invokes()[1].deadline, c.deadline(20, 80, 40), "the page's deadline less its own allowance, half its bound");
		assert.equal(c.invokes()[1].request, 1, "a new connection numbers its requests from 1");
		c.clock.advance(40);
		await until(second.settled, "the second page's ending");
		assert.deepEqual([second.value().ending, second.value().reason], ["unknown", "bound-passed"]);
		sameAsDirect(second.value(), c.calls[1], "the second page");
	});
});

test("PX5: the largest bound, 2147483647 ms, sends its deadline less the default allowance, and the proxy's call is bound 2147483597 ms", async () => {
	await withCase({}, async (c) => {
		const ending = await c.ended({ operation: "echo", input: "largest", bound: 2147483647 });
		assert.equal(c.invokes()[0].deadline, c.deadline(0, 2147483647, 50));
		assert.equal(c.calls[0].bound, 2147483597);
		sameAsDirect(ending, c.calls[0], "the largest bound");
	});
});

/**
 * Taps a case controls as it runs: `outboundMs` of transit for each invoke, moved on the hop clock while the
 * message is in flight; `holdEnds`, which keeps each end the proxy half writes until released; `holdAborts`,
 * which keeps each relayed abort until released.
 */
function transit() {
	const t = {
		clock: undefined, outboundMs: 0, holdEnds: false, holdAborts: false, ends: [], aborts: [],
		inbound(value, deliver) {
			if (value.type === "invoke" && t.outboundMs > 0) t.clock.advance(t.outboundMs);
			if (value.type === "abort" && t.holdAborts) t.aborts.push(deliver);
			else deliver();
		},
		outbound(message, write) {
			if (message.type === "end" && t.holdEnds) t.ends.push(write);
			else write();
		},
	};
	return t;
}

/** Opens a case with a transit controller bound to its clock. */
async function withTransit(options, body) {
	const t = transit();
	await withCase({ ...options, inbound: t.inbound, outbound: t.outbound }, async (c) => {
		t.clock = c.clock;
		await body(c, t);
	});
}

test("PX5: the deadline sent for the default allowance and for bounds of 99, 100, 101, 2 and 1 ms, whose allowances are 49, 50, 50, 1 and 0, each run to its ending", async () => {
	await withTransit({}, async (c) => {
		for (const [bound, allowance] of [[1000, 50], [99, 49], [100, 50], [101, 50], [2, 1], [1, 0]]) {
			const at = c.clock.elapsedMs();
			const n = c.calls.length;
			const call = watch(c.call({ operation: "silent", bound }));
			await until(() => c.calls.length === n + 1, `the call of ${bound} ms made`);
			assert.equal(c.invokes().at(-1).deadline, c.deadline(at, bound, allowance), `the deadline sent for ${bound} ms`);
			assert.equal(c.calls[n].bound, bound - allowance, `the proxy's call of ${bound} ms is bound ${bound - allowance} ms`);
			c.clock.advance(bound - allowance);
			await until(call.settled, `the ending of ${bound} ms`);
			if (allowance > 0) {
				assert.deepEqual([call.value().ending, call.value().reason], ["unknown", "bound-passed"], `${bound} ms`);
				sameAsDirect(call.value(), c.calls[n], `${bound} ms, decided at its floored deadline and read before the client half's`);
			} else {
				// With no margin the call decides at the client half's own deadline, which comes first: hop-stalled.
				assert.deepEqual([call.value().ending, call.value().reason, call.value().deliveryReport], ["unknown", "hop-stalled", null], `${bound} ms`);
			}
			c.clock.advance(allowance);
			await settle();
			assert.equal(call.count(), 1);
		}
	});
});

test("PX5: a bound of 2 ms with an allowance of 1 is refused deadline-passed whenever the hop takes any time, while with an application allowance of 0 it is made; a bound of 1 ms too", async () => {
	await withTransit({}, async (c, t) => {
		t.outboundMs = 0.001;
		for (const [bound, repeat] of [[2, false], [1, true]]) {
			const invocation = c.client.newInvocation();
			const ending = await c.ended({ operation: "echo", bound, invocation, repeat });
			assert.deepEqual(ending, { ending: "not-delivered", invocation, attempt: null, operation: "echo", agpCode: null, proxyCode: "deadline-passed", earlierAttemptsUncertain: repeat }, `${bound} ms with a hop of 1 microsecond`);
		}
		assert.equal(c.calls.length, 0, "neither was handed on");
	});
	await withTransit({ allowanceMs: 0 }, async (c, t) => {
		t.outboundMs = 0.5;
		const ending = await c.ended({ operation: "echo", input: "made", bound: 2 });
		assert.equal(c.invokes()[0].deadline, c.deadline(0, 2, 0));
		assert.equal(c.calls[0].bound, 1, "1.5 ms left, rounded down");
		sameAsDirect(ending, c.calls[0], "a bound of 2 ms with an allowance of 0");
		t.outboundMs = 1;
		assert.equal((await c.ended({ operation: "echo", input: "exactly", bound: 2 })).answer, "exactly", "with a hop of 1 ms, exactly 1 ms is left, and the call is made");
		assert.equal(c.calls[1].bound, 1);
		t.outboundMs = 1.001;
		assert.equal((await c.ended({ operation: "echo", bound: 2 })).proxyCode, "deadline-passed", "with a hop of 1.001 ms, less than 1 ms is left");
		assert.equal(c.calls.length, 2);
	});
});

test("PX5: the deadline sent for an application's own allowance, and allowances of 0 and of 1000, each run to its ending", async () => {
	await withTransit({ allowanceMs: 200 }, async (c) => {
		const call = watch(c.call({ operation: "silent", bound: 1000 }));
		await until(() => c.calls.length === 1, "the call made");
		assert.equal(c.invokes()[0].deadline, c.deadline(0, 1000, 200));
		c.clock.advance(800);
		await until(call.settled, "the ending");
		sameAsDirect(call.value(), c.calls[0], "an allowance of 200 ms");
	});
	await withTransit({ allowanceMs: 1000 }, async (c) => {
		for (const [bound, allowance] of [[3000, 1000], [1000, 500]]) {
			const at = c.clock.elapsedMs();
			const n = c.calls.length;
			const call = watch(c.call({ operation: "silent", bound }));
			await until(() => c.calls.length === n + 1, "the call made");
			assert.equal(c.invokes().at(-1).deadline, c.deadline(at, bound, allowance));
			c.clock.advance(bound - allowance);
			await until(call.settled, "the ending");
			assert.equal(call.value().reason, "bound-passed");
			sameAsDirect(call.value(), c.calls[n], `an allowance of 1000 ms, a bound of ${bound} ms`);
			assert.equal((await c.ended({ operation: "echo", input: bound })).answer, bound);
		}
	});
	await withTransit({ allowanceMs: 0 }, async (c, t) => {
		assert.equal((await c.ended({ operation: "echo", input: 0 })).answer, 0, "answered with an allowance of 0");
		const atDeadline = watch(c.call({ operation: "silent", bound: 1000 }));
		await until(() => c.calls.length === 2, "the call made");
		assert.equal(c.invokes()[1].deadline, c.deadline(c.clock.elapsedMs(), 1000, 0));
		c.clock.advance(1000);
		await until(atDeadline.settled, "the ending");
		assert.equal(atDeadline.value().reason, "hop-stalled", "with no margin and no transit, the client half's deadline comes first");
		t.outboundMs = 0.5;
		const sooner = watch(c.call({ operation: "silent", bound: 1000 }));
		await until(() => c.calls.length === 3, "the call made");
		assert.equal(c.calls[2].bound, 999, "999.5 ms left, rounded down");
		c.clock.advance(999);
		await until(sooner.settled, "the ending");
		assert.equal(sooner.value().reason, "bound-passed", "a deadline floored short of the allowance leaves time to read it");
		sameAsDirect(sooner.value(), c.calls[2], "an allowance of 0 whose call decides at its floored deadline");
	});
});

/**
 * Runs a silent call of 1000 ms whose invoke takes `outboundMs` to cross, lets its proxy's call decide at its
 * floored deadline, holds the end, and gives it to the client half `returnMs` after the call decided - moving
 * the clock without running timers, so the client half reads it before its own timer runs, even at its
 * deadline. Returns the ending and the call's record.
 */
async function timedReturn(c, t, outboundMs, returnMs) {
	t.outboundMs = outboundMs;
	t.holdEnds = true;
	const n = c.calls.length;
	const start = c.clock.nowNs();
	const call = watch(c.call({ operation: "silent", bound: 1000 }));
	await until(() => c.calls.length === n + 1, "the call made");
	const record = c.calls[n];
	const decides = record.at + ns(record.bound);
	c.clock.advance(Number(decides - c.clock.nowNs()) / 1e6);
	await until(() => t.ends.length === 1, "the call decided and its end held");
	c.clock.move(returnMs);
	t.ends.shift()();
	await until(call.settled, "the ending");
	c.clock.advance(Math.max(0, Number(start + ns(1000) - c.clock.nowNs()) / 1e6) + 1);
	await settle();
	assert.equal(call.count(), 1);
	t.holdEnds = false;
	t.outboundMs = 0;
	return { ending: call.value(), record, readAt: decides + ns(returnMs), deadline: start + ns(1000) };
}

test("PX5, PX6: returns taking just less than the allowance, exactly it and just more, at whole and fractional milliseconds: taken when read before the client half's deadline, hop-stalled when read at or after it", async () => {
	await withTransit({}, async (c, t) => {
		// A whole-millisecond deadline: the call decides exactly the allowance before the client half's.
		for (const [returnMs, taken] of [[49, true], [49.999, true], [50, false], [51, false]]) {
			const { ending, record, readAt, deadline } = await timedReturn(c, t, 0, returnMs);
			assert.equal(record.bound, 950);
			if (taken) sameAsDirect(ending, record, `a return of ${returnMs} ms, read ${Number(deadline - readAt) / 1e6} ms before the deadline`);
			else assert.deepEqual([ending.ending, ending.reason, ending.agpCode, ending.deliveryReport, ending.attempt], ["unknown", "hop-stalled", null, null, null], `a return of ${returnMs} ms, read at or after the deadline`);
		}
		// A deadline floored short of the allowance: an outbound transit of 0.4 ms leaves the call 949 ms, so it
		// decides 50.6 ms before the client half's deadline, and a return longer than the allowance is still taken.
		for (const [returnMs, taken] of [[49.9, true], [50, true], [50.5, true], [50.6, false], [51, false]]) {
			const { ending, record } = await timedReturn(c, t, 0.4, returnMs);
			assert.equal(record.bound, 949);
			if (taken) sameAsDirect(ending, record, `a return of ${returnMs} ms after a floored deadline`);
			else assert.equal(ending.reason, "hop-stalled", `a return of ${returnMs} ms after a floored deadline, read at or after the deadline`);
		}
	});
});

test("PX5: a return longer than the allowance after an early answer is still read before the client half's deadline, and taken unchanged", async () => {
	await withTransit({}, async (c, t) => {
		t.holdEnds = true;
		const call = watch(c.call({ operation: "hold", input: "early", bound: 1000 }));
		await until(() => c.a.holds.length === 1, "the operation runs");
		c.clock.advance(10);
		c.a.holds[0].release();
		await until(() => t.ends.length === 1, "the answer, its end held");
		c.clock.advance(60);
		t.ends.shift()();
		await until(call.settled, "the ending");
		assert.equal(call.value().answer.input, "early");
		sameAsDirect(call.value(), c.calls[0], "an early answer returned in 60 ms");
	});
});

test("PX5, PX6: an answer, a refusal, a rejection and a delivery report observed at or after the proxy's call's deadline, before its own timer has run, each lose to that deadline", async () => {
	await withCase({}, async (c) => {
		for (const [what, operation, input] of [["an answer", "hold", {}], ["a refusal", "hold-refuses", REFUSAL]]) {
			const n = c.calls.length;
			const call = watch(c.call({ operation, input, bound: 1000 }));
			await until(() => c.a.holds.length === n + 1, "the operation runs");
			c.clock.move(950);
			c.a.holds[n].release();
			await until(call.settled, `${what} observed`);
			assert.deepEqual([call.value().ending, call.value().reason], ["unknown", "bound-passed"], what);
			sameAsDirect(call.value(), c.calls[n], what);
			c.clock.advance(50);
		}
		// AGP's rejection of a send held for admission, by the abort relayed across the hop.
		const release = c.hooks.holdExecutor("proxy");
		const controller = new AbortController();
		const rejected = watch(c.call({ operation: "which", bound: 1000, signal: controller.signal }));
		await until(() => c.calls.length === 3, "the call made, its send held");
		c.clock.move(950);
		controller.abort();
		await until(rejected.settled, "the rejection observed");
		await release();
		assert.deepEqual([rejected.value().ending, rejected.value().reason, rejected.value().deliveryReport], ["unknown", "bound-passed", null]);
		sameAsDirect(rejected.value(), c.calls[2], "a rejection");
		c.clock.advance(50);
		// AGP's report that the request failed.
		const held = c.hooks.holdExecutor("host-b");
		const closing = c.b.close();
		await settle();
		const failed = watch(c.call({ operation: "which", host: "host-b", bound: 1000 }));
		await until(() => c.calls.length === 4, "the call made");
		await settle();
		c.clock.move(950);
		await held();
		await closing;
		for (let i = 0; i < 4000 && !failed.settled(); i++) { c.hooks.advanceAgpClock(0); await settle(1); }
		assert.ok(c.hooks.reports().includes("failed"), "AGP reported the request failed");
		assert.deepEqual([failed.value().ending, failed.value().reason], ["unknown", "bound-passed"], "a report of failure");
		sameAsDirect(failed.value(), c.calls[3], "a report of failure");
	});
});

test("PX5: a find of 100 ms whose later page is handed on with 80 ms gone: its transmitted deadline is its page's, less half its 20 ms, and its ending is checked", async () => {
	await withCase({}, async (c) => {
		const first = watch(c.call({ operation: "hold", input: "page 1", bound: 100 }));
		await until(() => c.a.holds.length === 1, "the first page runs");
		c.clock.advance(40);
		c.a.holds[0].release();
		await until(first.settled, "the first page");
		assert.equal(first.value().ending, "answered");
		// The find's own work between pages, until 80 ms of its 100 are gone.
		c.clock.advance(40);
		const second = watch(c.call({ operation: "silent", input: "page 2", bound: 20 }));
		await until(() => c.calls.length === 2, "the later page made");
		assert.equal(c.invokes()[1].deadline, c.deadline(80, 20, 10));
		assert.equal(c.calls[1].bound, 10);
		c.clock.advance(10);
		await until(second.settled, "the later page's ending");
		assert.deepEqual([second.value().ending, second.value().reason], ["unknown", "bound-passed"]);
		sameAsDirect(second.value(), c.calls[1], "the later page");
	});
});

test("PX5, PX6: an abort before the send is admitted ends not-delivered with agpCode ABORTED; one after changes nothing; the client half alone never ends on an abort", async () => {
	await withCase({}, async (c) => {
		const before = new AbortController();
		before.abort();
		const aborted = await c.ended({ operation: "which", signal: before.signal });
		assert.equal(c.invokes()[0].aborted, true, "aborted crosses with the invoke");
		assert.equal(c.calls[0].abortedAtCall, true, "the proxy's call was made with its signal already fired");
		assert.deepEqual([aborted.ending, aborted.agpCode, aborted.proxyCode], ["not-delivered", "ABORTED", null]);
		sameAsDirect(aborted, c.calls[0], "an abort before the send");
		const afterwards = new AbortController();
		const call = watch(c.call({ operation: "hold", input: "after", signal: afterwards.signal }));
		await until(() => c.a.holds.length === 1, "admitted, and the operation runs");
		afterwards.abort();
		await until(() => c.calls[1].abortedAt !== undefined, "the abort relayed to the proxy's call");
		assert.deepEqual(c.hop.sent("abort"), [{ operationProxy: 1, type: "abort", request: 2 }]);
		await settle();
		assert.ok(!call.settled(), "the abort ends nothing by itself");
		c.a.holds[0].release();
		await until(call.settled, "the answer");
		assert.equal(call.value().answer.input, "after");
		sameAsDirect(call.value(), c.calls[1], "an abort after admission");
	});
});

test("PX5: an abort crossing the hop while the send is held for admission decides as it arrives: before admission not-delivered ABORTED, after admission nothing", async () => {
	await withTransit({}, async (c) => {
		const release = c.hooks.holdExecutor("proxy");
		const controller = new AbortController();
		const call = watch(c.call({ operation: "which", signal: controller.signal }));
		await until(() => c.calls.length === 1, "the call made, its send held for admission");
		controller.abort();
		await until(call.settled, "AGP's refusal");
		await release();
		assert.deepEqual([call.value().ending, call.value().agpCode], ["not-delivered", "ABORTED"]);
		assert.equal(c.calls[0].abortedAtCall, false);
		assert.ok(c.calls[0].abortedAt !== undefined, "the relayed abort fired the call's signal");
		sameAsDirect(call.value(), c.calls[0], "an abort arriving before admission");
	});
	await withTransit({}, async (c, t) => {
		const release = c.hooks.holdExecutor("proxy");
		const controller = new AbortController();
		const call = watch(c.call({ operation: "hold", input: "admitted first", signal: controller.signal }));
		await until(() => c.calls.length === 1, "the call made, its send held for admission");
		t.holdAborts = true;
		controller.abort();
		await until(() => t.aborts.length === 1, "the abort crossing the hop");
		let admitted = false;
		c.hooks.afterNextAdmission(() => { admitted = true; });
		await release();
		await until(() => admitted, "the send admitted");
		t.aborts.shift()();
		await until(() => c.calls[0].abortedAt !== undefined, "the abort, arriving after admission, fired the call's signal");
		await until(() => c.a.holds.length === 1, "the operation runs");
		await settle();
		assert.ok(!call.settled(), "nothing ended the call");
		c.a.holds[0].release();
		await until(call.settled, "the answer");
		assert.equal(call.value().ending, "answered", "an abort arriving after admission changes nothing");
		sameAsDirect(call.value(), c.calls[0], "an abort arriving after admission");
	});
});

test("PX5: the wall clock stepped forward and back while a call is in flight moves neither deadline: the hop runs on CLOCK_MONOTONIC", { timeout: 60_000 }, async () => {
	const realNow = Date.now;
	// On the real clock of a loaded machine, an allowance of 400 ms leaves the return wide room.
	await withCase({ clock: machineClock, allowanceMs: 400 }, async (c) => {
		try {
			const started = process.hrtime.bigint();
			const call = watch(c.call({ operation: "silent", bound: 1200 }));
			await until(() => c.calls.length === 1, "the call made");
			const sent = BigInt(c.invokes()[0].deadline);
			assert.ok(sent - started >= ns(800) && sent - started < ns(810), "the deadline sent is on CLOCK_MONOTONIC, 800 ms after invoking");
			Date.now = () => realNow() + 86_400_000;
			await sleep(200);
			Date.now = () => realNow() - 86_400_000;
			await until(call.settled, "the ending", 20_000);
			const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
			assert.deepEqual([call.value().ending, call.value().reason], ["unknown", "bound-passed"]);
			sameAsDirect(call.value(), c.calls[0], "a call with the wall clock stepped");
			assert.ok(elapsed >= 799, `not before the proxy's call's floored deadline: ${elapsed} ms`);
		} finally {
			Date.now = realNow;
		}
	});
});

/** An input whose reading, as the client half checks it, moves the hop clock `ms` and gives `value`: a slow getter. */
const slowInput = (c, ms, value) => ({ get n() { c.clock.move(ms); return value; } });

/** Asserts an ending of the client half's own checks with the deadline passed: as the call layer's caller ends it. */
function passedWhileChecking(ending, operation, what, invocation) {
	assert.deepEqual(Object.keys(ending).sort(), ["agpCode", "attempt", "deliveryReport", "ending", "invocation", "operation", "reason"], `${what}: exactly an unknown ending's fields`);
	assert.deepEqual([ending.ending, ending.reason, ending.agpCode, ending.deliveryReport, ending.operation], ["unknown", "bound-passed", null, null, operation], `${what}: unknown, bound-passed, no AGP code or delivery report`);
	if (invocation !== undefined) assert.equal(ending.invocation, invocation, `${what}: the invocation given`);
	assert.match(ending.invocation, /^\d{13}-[0-9a-f]{16}$/, `${what}: an invocation identity`);
	assert.match(ending.attempt, /^\d{13}-[0-9a-f]{16}\.[0-9a-f]{8}$/, `${what}: the attempt identity it made, as EM11 writes it`);
	assert.ok(ending.attempt.startsWith(`${ending.invocation}.`), `${what}: an attempt of its invocation`);
	assert.ok(Object.isFrozen(ending), `${what}: frozen`);
}

test("PX5, PX6: a deadline passing while the client half checks an invocation, prepared and unprepared, with a sendable and an unsendable input, and at the deadline exactly, ends unknown with bound-passed, its attempt identity and nothing written; a check finishing before the deadline refuses not-sendable exactly", { timeout: 60_000 }, async () => {
	await withCase({}, async (c) => {
		const bound = 100;
		const variants = [
			["a sendable input, the deadline passed", 107.5, 1],
			["a sendable input, at the deadline exactly", 100, 1],
			["an unsendable input, the deadline passed", 107.5, 2 ** 60],
			// The second verification's reproduction: a getter spending the whole bound and giving an unsafe integer.
			["an unsendable input, at the deadline exactly", 100, 2 ** 60],
		];
		const check = async (state) => {
			for (const [what, ms, value] of variants) {
				const wire = c.wire.length;
				const invocation = c.client.newInvocation();
				const ending = await c.call({ operation: "echo", input: slowInput(c, ms, value), bound, invocation });
				passedWhileChecking(ending, "echo", `${state}, ${what}`, invocation);
				passedWhileChecking(await c.call({ operation: "echo", input: slowInput(c, ms, value), bound }), "echo", `${state}, ${what}, no invocation given`);
				assert.equal(c.wire.length, wire, `${state}, ${what}: nothing written`);
			}
			// The check finishing a nanosecond before the deadline: the refusal the check found stands, exactly.
			const wire = c.wire.length;
			const refused = await c.call({ operation: "echo", input: slowInput(c, 99.999999, 2 ** 60), bound });
			assert.deepEqual(Object.keys(refused).sort(), ["attempt", "ending", "invocation", "operation", "refusal"], `${state}: exactly a refused ending's fields`);
			assert.deepEqual([refused.ending, refused.refusal], ["refused", NOT_SENDABLE], `${state}: refused not-sendable, exactly as the call layer refuses`);
			assert.ok(refused.attempt.startsWith(`${refused.invocation}.`) && Object.isFrozen(refused), `${state}: under its attempt identity, frozen`);
			assert.equal(c.wire.length, wire, `${state}: nothing written`);
		};
		await check("unprepared");
		assert.deepEqual(c.wire, [], "unprepared: nothing written at all, not even hello, and no proxy made a call");
		assert.equal(c.hop.launches(), 0, "unprepared: nothing launched");
		assert.equal((await c.ended({ operation: "echo", input: "prepared" })).answer, "prepared", "an invocation prepares the client half");
		await check("prepared");
		assert.equal(c.invokes().length, 1, "prepared: only the one call was ever written");
		assert.equal(c.calls.length, 1, "the proxy made only that call");
	});
});

// ---------------------------------------------------------------------------------------------------------
// PX6 - how a proxied invocation ends; PX10's held and stopped hops.

test("PX6: each of the call layer's four endings arrives through the proxy as from the direct call the proxy made, unchanged", async () => {
	await withCase({}, async (c) => {
		const answered = await c.ended({ operation: "echo", input: { text: "caf\u00e9", list: [1, 2.5, null] } });
		const refused = await c.ended({ operation: "refuses", input: REFUSAL });
		const notDelivered = await c.ended({ operation: "not-declared" });
		const failed = await c.ended({ operation: "throws" });
		const atBound = watch(c.call({ operation: "silent", bound: 400 }));
		await until(() => c.calls.length === 5, "the silent call made");
		c.clock.advance(350);
		await until(atBound.settled, "the ending at the proxy's call's bound");
		const endings = [answered, refused, notDelivered, failed, atBound.value()];
		assert.deepEqual(endings.map((e) => e.ending), ["answered", "refused", "not-delivered", "unknown", "unknown"]);
		assert.deepEqual(refused.refusal, REFUSAL);
		assert.deepEqual([notDelivered.agpCode, notDelivered.proxyCode], ["NO_ROUTE", null], "the call layer's not-delivered ending carries proxyCode null");
		assert.deepEqual([failed.reason, failed.agpCode], ["operation-failed", null]);
		endings.forEach((e, i) => sameAsDirect(e, c.calls[i], e.ending));
	});
});

test("PX6: a call that runs out its bound through a working proxy ends unknown with bound-passed and the call layer's delivery report, the allowance before the client half's bound passes", async () => {
	await withCase({}, async (c) => {
		const call = watch(c.call({ operation: "silent", bound: 1000 }));
		await until(() => c.a.runs.length === 1, "the operation runs");
		for (let i = 0; i < 4000 && !c.hooks.reports().includes("delivered"); i++) { c.hooks.advanceAgpClock(0); await settle(1); }
		c.clock.advance(949);
		await settle();
		assert.ok(!call.settled(), "nothing before the proxy's call's deadline");
		c.clock.advance(1);
		await until(call.settled, "the ending");
		assert.deepEqual(call.value(), { ending: "unknown", invocation: call.value().invocation, attempt: call.value().attempt, operation: "silent", reason: "bound-passed", agpCode: null, deliveryReport: "delivered" });
		assert.equal(c.clock.elapsedMs(), 950, "ended 50 ms before the client half's bound");
		sameAsDirect(call.value(), c.calls[0], "a call run out at its bound");
	});
});

test("PX6, PX10: a hop whose fixture holds the proxy half's writing of an end until after the client half's deadline ends it unknown with hop-stalled, and the ending released afterwards is discarded", async () => {
	await withTransit({}, async (c, t) => {
		t.holdEnds = true;
		const call = watch(c.call({ operation: "echo", input: "held", bound: 1000 }));
		await until(() => t.ends.length === 1, "the answer, its end held");
		assert.equal(c.calls[0].ending.ending, "answered", "the proxy's call was answered at once");
		c.clock.advance(999);
		await settle();
		assert.ok(!call.settled(), "nothing before the client half's deadline");
		c.clock.advance(1);
		await until(call.settled, "the ending at the client half's deadline");
		const ending = call.value();
		assert.deepEqual(ending, { ending: "unknown", invocation: ending.invocation, attempt: null, operation: "echo", reason: "hop-stalled", agpCode: null, deliveryReport: null });
		t.holdEnds = false;
		t.ends.shift()();
		await until(() => c.hop.sent("end").length === 1, "the end released onto the channel");
		await settle();
		assert.equal(call.count(), 1, "one ending");
		assert.equal(call.value(), ending, "the released ending is discarded");
		assert.equal((await c.ended({ operation: "echo", input: "next" })).answer, "next", "the same connection carries the next invocation");
		assert.equal(c.hop.sent("hello").length, 1);
	});
});

test("PX6: an answer, a refusal and a delivery report each falling between the proxy's call's bound and the client half's deadline: none taken", async () => {
	await withCase({ holdDeliveryReports: true }, async (c) => {
		for (const [what, operation, input] of [["an answer", "hold", {}], ["a refusal", "hold-refuses", REFUSAL]]) {
			const n = c.calls.length;
			const call = watch(c.call({ operation, input, bound: 1000 }));
			await until(() => c.a.holds.length === n + 1, "the operation runs");
			c.clock.advance(950);
			await until(call.settled, "the ending at the proxy's call's bound");
			c.clock.advance(10);
			c.a.holds[n].release();
			await settle(60);
			c.clock.advance(40);
			await settle();
			assert.equal(call.count(), 1);
			assert.deepEqual([call.value().ending, call.value().reason, call.value().deliveryReport], ["unknown", "bound-passed", null], `${what} 10 ms after the proxy's call's bound`);
			sameAsDirect(call.value(), c.calls[n], what);
		}
		const call = watch(c.call({ operation: "hold", input: "report", bound: 1000 }));
		await until(() => c.a.holds.length === 3, "the operation runs");
		c.clock.advance(950);
		await until(call.settled, "the ending at the proxy's call's bound");
		c.clock.advance(10);
		c.hooks.loseChannel("host-a");
		await until(() => c.hooks.reports().includes("unknown"), "AGP's report of unknown, after the call's bound");
		await settle();
		assert.equal(call.count(), 1);
		assert.deepEqual([call.value().reason, call.value().deliveryReport], ["bound-passed", null], "the report after the bound is not taken");
	});
});

test("PX6: an application allowance of 0, whose invocation runs out its bound, ends bound-passed or hop-stalled as the race falls, and never otherwise", { timeout: 60_000 }, async () => {
	await withCase({ clock: machineClock, allowanceMs: 0 }, async (c) => {
		const seen = new Set();
		for (let i = 0; i < 12; i++) {
			const ending = await c.ended({ operation: "silent", bound: 25 });
			assert.equal(ending.ending, "unknown");
			assert.ok(["bound-passed", "hop-stalled"].includes(ending.reason), `call ${i + 1} ended ${ending.reason}`);
			if (ending.reason === "bound-passed") sameAsDirect(ending, c.calls[i], `call ${i + 1}`);
			else assert.deepEqual([ending.attempt, ending.agpCode, ending.deliveryReport], [null, null, null]);
			seen.add(ending.reason);
		}
		assert.ok(seen.size >= 1);
	});
});

test("PX6: a proxy whose caller throws or rejects a programming error for an invocation - the call layer's answer to a call that skipped the client half's checks - sends nothing for it, and the client half's deadline ends it hop-stalled", async () => {
	const wrapCaller = (recording) => ({
		invoke(call) {
			if (call.input === "throws") throw new TypeError("a programming error, thrown");
			if (call.input === "rejects") return Promise.reject(new TypeError("a programming error, rejected"));
			return recording.invoke(call);
		},
	});
	await withCase({ wrapCaller }, async (c) => {
		for (const [n, how] of ["throws", "rejects"].entries()) {
			const call = watch(c.call({ operation: "echo", input: how, bound: 1000 }));
			await until(() => c.invokes().length === n + 1, `the ${how} invocation written`);
			await until(() => c.hop.half.inFlight() === 0, `the ${how} call over`);
			await settle();
			assert.equal(c.hop.sent("end").length, 0, `nothing sent for the call that ${how}`);
			c.clock.advance(999);
			await settle();
			assert.ok(!call.settled(), `${how}: nothing decides it before the client half's deadline`);
			c.clock.advance(1);
			await until(call.settled, `${how}: the client half's deadline`);
			assert.deepEqual(call.value(), { ending: "unknown", invocation: call.value().invocation, attempt: null, operation: "echo", reason: "hop-stalled", agpCode: null, deliveryReport: null }, how);
		}
		assert.equal((await c.ended({ operation: "echo", input: "next" })).answer, "next", "the connection carries the next invocation");
		assert.equal(c.hop.half.connections(), 1, "on the same connection");
	});
});

test("PX6: a channel closed after welcome and before any byte of an invocation is written is no proxy at all: the client half connects and launches again", async () => {
	let closeAfterWelcome = true;
	await withCase({ outbound: (message, write) => {
		write();
		if (message.type === "welcome" && closeAfterWelcome) {
			closeAfterWelcome = false;
			queueMicrotask(() => c0.hop.proxyLinks[0].close());
		}
	} }, async (c) => {
		c0 = c;
		assert.equal(await c.client.prepare({ timeMs: 1000 }), "ready");
		await until(() => c.hop.half.connections() === 0, "the channel closed after welcome");
		await settle();
		const ending = await c.ended({ operation: "echo", input: "on a new connection" });
		assert.equal(ending.answer, "on a new connection");
		assert.equal(c.hop.sent("hello").length, 2, "connected again");
		assert.equal(c.hop.sent("invoke")[0].request, 1);
		assert.equal(c.hop.launches(), 0, "the proxy still listens, so the connection is made without launching");
	});
});
let c0;

const fixtures = [];
after(async () => { for (const f of fixtures) await f.cleanup(); });

/**
 * A client half in this process whose proxy is the fixture application's, a real child process launched on
 * demand as the machine adapter launches it; every message it reads is recorded, with the moment it was read
 * on CLOCK_MONOTONIC.
 */
function processClient(options = {}) {
	const f = fixture(options);
	fixtures.push(f);
	const read = [];
	const launch = { command: process.execPath, args: [PROXY_MAIN, f.configFile] };
	const client = createProxyClient({
		key: f.config.key, clock: machineClock, identities: machineIdentities,
		connector: {
			connect: (handlers) => connectChannel(f.socketPath(), { message: (value) => { read.push({ at: process.hrtime.bigint(), value }); handlers.message(value); }, closed: () => handlers.closed() }),
			launch: () => spawn(launch.command, launch.args, { detached: true, stdio: "ignore" }).unref(),
		},
	});
	return { f, client, read, call: (request) => client.invoke({ host: "host-a", service: "fixture", input: {}, bound: 30_000, ...request }) };
}

/** The pid of the proxy serving a process client, once prepared. */
async function servingPid(p) {
	assert.equal(await p.client.prepare({ timeMs: 20_000 }), "ready");
	return (await p.call({ operation: "which" })).answer.pid;
}

test("PX6 (processes): a proxy killed after the invocation was written ends it unknown with proxy-lost at once", { timeout: 60_000 }, async () => {
	const p = processClient();
	const pid = await servingPid(p);
	const call = watch(p.call({ operation: "hold", bound: 30_000 }));
	await waitFor(() => p.f.runs().some((r) => r.operation === "hold"), "the invocation to reach the host");
	const killed = process.hrtime.bigint();
	process.kill(pid, "SIGKILL");
	await until(call.settled, "the ending", 10_000);
	const ms = Number(process.hrtime.bigint() - killed) / 1e6;
	assert.deepEqual(call.value(), { ending: "unknown", invocation: call.value().invocation, attempt: null, operation: "hold", reason: "proxy-lost", agpCode: null, deliveryReport: null });
	assert.ok(ms < 5000, `at once, not at the bound of 30 s: ${Math.round(ms)} ms`);
	p.client.close();
});

test("PX6, PX10 (processes): a proxy stopped with SIGSTOP ends the invocation unknown with hop-stalled at the bound; stopped before its call decides, the ending it sends after SIGCONT is discarded", { timeout: 60_000 }, async () => {
	const p = processClient();
	const pid = await servingPid(p);
	const started = process.hrtime.bigint();
	const call = watch(p.call({ operation: "hold", bound: 2500 }));
	await waitFor(() => p.f.runs().some((r) => r.operation === "hold"), "the invocation to reach the host");
	process.kill(pid, "SIGSTOP");
	try {
		await until(call.settled, "the ending", 20_000);
		const ms = Number(process.hrtime.bigint() - started) / 1e6;
		const ending = call.value();
		assert.deepEqual(ending, { ending: "unknown", invocation: ending.invocation, attempt: null, operation: "hold", reason: "hop-stalled", agpCode: null, deliveryReport: null });
		assert.ok(ms >= 2499, `at the bound, not before: ${ms} ms`);
		const endsBefore = p.read.filter((r) => r.value.type === "end").length;
		const decided = process.hrtime.bigint();
		process.kill(pid, "SIGCONT");
		await waitFor(() => p.read.filter((r) => r.value.type === "end").length > endsBefore, "the proxy's ending, sent after SIGCONT");
		const late = p.read.filter((r) => r.value.type === "end").at(-1);
		assert.ok(late.at > decided, "the ending was read after the invocation had ended");
		assert.equal(late.value.ending.reason, "bound-passed", "the proxy's call ran out its bound while stopped");
		await sleep(100);
		assert.equal(call.count(), 1);
		assert.equal(call.value(), ending, "the ending sent after SIGCONT is discarded");
	} finally {
		try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
	}
	p.client.close();
});

test("PX6 (processes): a channel closed after welcome and before writing, its proxy killed, leads to a new proxy", { timeout: 60_000 }, async () => {
	const p = processClient();
	const pid = await servingPid(p);
	process.kill(pid, "SIGKILL");
	await sleep(300);
	const ending = await p.call({ operation: "which", bound: 20_000 });
	assert.equal(ending.ending, "answered", JSON.stringify(ending));
	assert.notEqual(ending.answer.pid, pid, "a new proxy carried it");
	assert.equal(p.f.owners().length, 2);
	p.client.close();
});

test("PX6 (processes): a client killed during a call leaves the fixture host one request, and the proxy finishes the call and never repeats it", { timeout: 60_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	const c = f.client({ operation: "hold", bound: 20_000 });
	await waitFor(() => f.runs().some((r) => r.operation === "hold"), "the call to reach the host");
	c.child.kill("SIGKILL");
	await c.exited;
	const proxy = f.owners()[0];
	fs.writeFileSync(path.join(f.records, "release"), "");
	await sleep(1500);
	const holds = f.runs().filter((r) => r.operation === "hold");
	assert.equal(holds.length, 1, "one request reached the host, and no second");
	assert.ok(!c.acked(), "the killed client acknowledged nothing");
	const next = await f.client({ operation: "which" }).ack();
	assert.equal(next.ending.answer.pid, proxy, "the proxy runs on, having finished the call and dropped its ending");
	assert.equal(f.runs().filter((r) => r.operation === "hold").length, 1);
});

test("D2-E4, PX4, PX5, PX6, PX9, D54, D55: src/call-checks.ts is removed; CallRequest delegates to readCallRequest; CallLayerCaller.invoke, buildCaller and callerReady read results as plain data with zero getter calls and zero unhandled rejections", async () => {
	const { fileURLToPath } = await import("node:url");
	const os = await import("node:os");
	const { startMachineProxyIn } = await import("../../dist/machine-adapter.js");
	const here = path.dirname(fileURLToPath(import.meta.url));
	assert.equal(fs.existsSync(path.join(here, "..", "..", "src", "call-checks.ts")), false, "src/call-checks.ts does not exist");

	// 1. Client half reads clock first, then each field of CallRequest at most once via readCallRequest.
	const order = [];
	const clock = createManualHopClock();
	const trackedClock = {
		nowNs: () => { order.push("clock"); return clock.nowNs(); },
		schedule: (ms, fn) => clock.schedule(ms, fn),
	};
	const client = createProxyClient({
		key: KEY,
		clock: trackedClock,
		identities: machineIdentities,
		connector: {
			connect: async () => ({ kind: "refused", code: "key-mismatch" }),
			launch: () => undefined,
		},
	});
	const ending = await client.invoke({
		get host() { order.push("host"); return "host-a"; },
		get service() { order.push("service"); return "svc"; },
		get operation() { order.push("operation"); return "echo"; },
		get input() { order.push("input"); return { get x() { order.push("input.x"); return 1; } }; },
		get bound() { order.push("bound"); return 100; },
	});
	assert.equal(ending.ending, "not-delivered");
	assert.equal(order[0], "clock", "clock read first");
	assert.deepEqual(order.slice(1, 7), ["host", "service", "operation", "input", "input.x", "bound"], "each CallRequest field and input getter read once");

	// 2. Proxy half: non-plain / non-native-thenable / throwing CallLayerCaller.invoke results send nothing (hop-stalled),
	// keep the connection open, call zero getters, and leak zero unhandled rejections.
	let getters = 0;
	const unhandled = [];
	const onUnhandled = (r) => unhandled.push(r);
	process.on("unhandledRejection", onUnhandled);
	try {
		const sym = Symbol("s");
		const badResults = [
			(call) => ({ get ending() { getters++; return "answered"; }, invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: 1, p: Promise.reject(new Error("getter promise")) }),
			(call) => Promise.resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: { get x() { getters++; return 1; }, p: Promise.reject(new Error("answer getter promise")) } }),
			(call) => ({ then(resolve) { getters++; resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: 1 }); }, p: Promise.reject(new Error("thenable promise")) }),
			(call) => Promise.resolve(Object.create({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: 1 })),
			(call) => Promise.resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: 1, [sym]: 1 }),
			(call) => Promise.resolve({ ending: "not-delivered", invocation: call.invocation, attempt: null, operation: call.operation, agpCode: null, proxyCode: "deadline-passed", earlierAttemptsUncertain: false }),
			() => Promise.reject(Object.assign(new Error("invoke rejected"), { p: Promise.reject(new Error("invoke rejected nested")) })),
			() => { throw Object.assign(new Error("invoke threw"), { p: Promise.reject(new Error("invoke thrown nested")) }); },
		];
		let callIdx = 0;
		const hopClock = createManualHopClock();
		const half = createProxyHalf({ key: KEY, clock: hopClock, idleMs: 60_000, onIdle: () => undefined });
		half.ready({
			invoke(call) {
				if (call.operation === "good") {
					return Promise.resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer: call.input });
				}
				return badResults[callIdx++ % badResults.length](call);
			},
		}, callClockOf(hopClock));
		let toClient;
		let toProxy;
		const pairClient = createProxyClient({
			key: KEY,
			clock: hopClock,
			identities: machineIdentities,
			connector: {
				connect: async (clientHandlers) => {
					toClient = clientHandlers;
					toProxy = half.accept({
						write: (msg) => { toClient.message(msg); return true; },
						hold: () => undefined,
						close: () => toClient.closed(),
					});
					return {
						kind: "connected",
						link: {
							write: (msg) => { toProxy.message(msg); return true; },
							hold: () => undefined,
							close: () => toProxy.closed(),
						},
					};
				},
				launch: () => undefined,
			},
		});
		for (let i = 0; i < badResults.length; i++) {
			const pending = watch(pairClient.invoke({ host: "host-a", service: "svc", operation: "bad", input: i, bound: 200 }));
			await settle(5);
			hopClock.advance(200);
			await until(pending.settled, `bad case ${i}`);
			assert.deepEqual([pending.value().ending, pending.value().reason], ["unknown", "hop-stalled"], `bad case ${i} ends hop-stalled`);
		}
		const good = await pairClient.invoke({ host: "host-a", service: "svc", operation: "good", input: "ok", bound: 200 });
		assert.deepEqual([good.ending, good.answer], ["answered", "ok"], "the connection stays open and carries the next call");
		pairClient.close();
		half.stopIdle();

		// 3. startMachineProxyIn: buildCaller and callerReady plain-data and non-native-thenable checks.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "op-proxy-d2e4-"), { mode: 0o700 });
		try {
			const startupCases = [
				{
					buildCaller: () => ({ get caller() { getters++; return { invoke: () => Promise.resolve() }; }, stop: () => undefined, p: Promise.reject(new Error("buildCaller getter promise")) }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ then(resolve) { getters++; resolve({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined }); }, p: Promise.reject(new Error("buildCaller thenable promise")) }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, get extra() { getters++; return 1; } }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => Object.defineProperty({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined }, "hidden", { value: 1, enumerable: false }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, [Symbol("extra")]: 1 }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, extra: { p: Promise.reject(new Error("buildCaller extra nested promise")) } }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, extra: new (class Extra { p = Promise.reject(new Error("nested-build-class-extra")); })() }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, extra: new (class Extra { x = 1; })() }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined, extra: [new (class Extra { x = 1; })(), ...Array.from({ length: 1000 }, () => ({}))] }),
					callerReady: () => undefined,
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined }),
					callerReady: () => ({ then(resolve) { getters++; resolve(undefined); }, p: Promise.reject(new Error("callerReady thenable promise")) }),
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined }),
					callerReady: () => Promise.resolve({ extra: Promise.reject(new Error("callerReady non-undefined promise")) }),
				},
				{
					buildCaller: () => ({ caller: { invoke: () => Promise.resolve() }, stop: () => undefined }),
					callerReady: () => Promise.reject(Object.assign(new Error("callerReady rejected"), { p: Promise.reject(new Error("callerReady rejected nested")) })),
				},
			];
			for (const [i, app] of startupCases.entries()) {
				const proxy = await startMachineProxyIn(dir, { key: KEY, idleMs: 60_000, ...app });
				assert.equal(proxy.owner, true, `startup case ${i} owned`);
				assert.equal(await proxy.stopped, 1, `startup case ${i} failed startup with status 1`);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		await new Promise((r) => setTimeout(r, 30));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.equal(getters, 0, "zero getters or non-native thenables invoked");
	assert.deepEqual(unhandled, [], "zero unhandled rejections");
});
