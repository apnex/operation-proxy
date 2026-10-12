// client-clock-faults - the client half's own decisions with a clock port that throws (CONTRACT.md, PX5, PX6;
// zorg's target, EM12: a clock port that throws is a fault of the port, and the event the caller observed then
// decides). Beside the caller suite's cases, which run through a real hop in caller-interface-parity.test.js,
// these drive the client half's links on an injected clock: its own deadline - hop-stalled once written,
// proxy-unreachable before - and preparing's outcomes - welcome, a refusal, an unsafe runtime directory, nothing
// to connect to - each decided as a reading, a timer's cancellation or a timer's arming throws. Each ends once,
// frozen, its hold released and its waiter withdrawn, and no rejection goes unhandled and no exception escapes
// into the clock. Needs no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxyClient } from "@apnex/operation-proxy";
import { Preparer } from "../../dist/client-preparing.js";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";

const KEY = { application: "a", identity: "b", target: "c" };
const turns = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const welcome = { operationProxy: 1, type: "welcome" };
const answered = (invoke) => ({ operationProxy: 1, type: "end", request: invoke.request, ending: { ending: "answered", invocation: invoke.invocation, attempt: `${invoke.invocation}.0000abcd`, operation: invoke.operation, answer: "yes" } });

/** A manual hop clock through a port that, armed, throws once at its next reading, cancellation or arming of a timer. */
function faultyClock() {
	const manual = createManualHopClock();
	let armed;
	const faults = [];
	const live = new Set();
	const fail = (at) => {
		armed = undefined;
		faults.push(at);
		throw new Error(`clock ${at} fault`);
	};
	return {
		manual, faults, live,
		arm(at) { armed = at; },
		nowNs() { if (armed === "read") fail("read"); return manual.nowNs(); },
		schedule(ms, callback) {
			if (armed === "schedule") fail("schedule");
			const entry = {};
			live.add(entry);
			const timer = manual.schedule(ms, () => { live.delete(entry); callback(); });
			return { cancel() { if (armed === "cancel") fail("cancel"); live.delete(entry); timer.cancel(); } };
		},
	};
}

/** A connector whose links the test drives, counting its connections and launches; `outcome` may refuse to connect. */
function drivenConnector(outcome = () => "connected") {
	const links = [];
	const state = { links, launches: 0, connects: 0 };
	state.connector = {
		async connect(handlers) {
			state.connects++;
			const kind = outcome();
			if (kind !== "connected") return { kind };
			const link = {
				handlers, written: [], open: true, holds: [],
				write(message) { if (!link.open) return false; link.written.push(message); return true; },
				close() { if (!link.open) return; link.open = false; queueMicrotask(() => handlers.closed()); },
				hold(keep) { link.holds.push(keep); },
			};
			links.push(link);
			return { kind: "connected", link };
		},
		launch() { state.launches++; },
	};
	return state;
}

/** Runs a body, collecting every rejection left unhandled and exception left uncaught meanwhile. */
async function noneUnhandled(body) {
	const unhandled = [];
	const listener = (error) => unhandled.push(error);
	process.on("unhandledRejection", listener);
	process.on("uncaughtException", listener);
	try {
		await body();
		await turns(20);
	} finally {
		process.off("unhandledRejection", listener);
		process.off("uncaughtException", listener);
	}
	assert.deepEqual(unhandled.map(String), [], "no rejection unhandled and no exception uncaught");
}

/** Watches a promise. */
function watch(promise) {
	const w = { settled: false, value: undefined, count: 0 };
	promise.then((v) => { w.settled = true; w.value = v; w.count++; }, (e) => { w.settled = true; w.value = e; w.count++; });
	return w;
}

const newClient = (d, clock) => createProxyClient({ key: KEY, connector: d.connector, clock, identities: machineIdentities });
const call = (c, extra = {}) => c.invoke({ host: "h", service: "s", operation: "o", input: 1, bound: 1000, ...extra });

for (const at of ["read", "cancel"]) {
	test(`a written invocation whose own deadline decides as its clock port throws at a ${at === "read" ? "reading, at the timer's wakeup" : "timer's cancellation"} ends hop-stalled once, its hold released`, async () => {
		await noneUnhandled(async () => {
			const clock = faultyClock();
			const d = drivenConnector();
			const pending = watch(call(newClient(d, clock)));
			await turns();
			d.links[0].handlers.message(welcome);
			await turns();
			const invoke = d.links[0].written[1];
			assert.equal(invoke.type, "invoke");
			clock.arm(at);
			assert.doesNotThrow(() => clock.manual.advance(1000), "nothing the port throws escapes into its timer");
			await turns();
			assert.deepEqual(clock.faults, [at], "the port threw");
			assert.deepEqual([pending.value?.ending, pending.value?.reason, pending.value?.attempt], ["unknown", "hop-stalled", null]);
			assert.ok(Object.isFrozen(pending.value));
			assert.equal(d.links[0].holds.at(-1), false, "the hold released");
			d.links[0].handlers.message(answered(invoke));
			clock.manual.advance(5000);
			await turns();
			assert.equal(pending.count, 1, "one ending; the late end changes nothing");
			assert.equal(clock.live.size, 0, "no timer left");
		});
	});

	test(`an unprepared invocation whose own deadline decides as its clock port throws at a ${at === "read" ? "reading, at the timer's wakeup" : "timer's cancellation"} ends proxy-unreachable once, nothing written, its waiter withdrawn`, async () => {
		await noneUnhandled(async () => {
			const clock = faultyClock();
			const d = drivenConnector();
			const pending = watch(call(newClient(d, clock), { repeat: true }));
			await turns();
			clock.arm(at);
			assert.doesNotThrow(() => clock.manual.advance(1000));
			await turns();
			assert.deepEqual(clock.faults, [at]);
			assert.deepEqual([pending.value?.ending, pending.value?.proxyCode, pending.value?.earlierAttemptsUncertain], ["not-delivered", "proxy-unreachable", true]);
			assert.ok(Object.isFrozen(pending.value));
			assert.deepEqual(d.links[0].written.map((m) => m.type), ["hello"], "nothing of the invocation written");
			assert.equal(d.links[0].open, false, "withdrawn, the connection still waiting for welcome is closed");
			const connects = d.connects;
			clock.manual.advance(5000);
			await turns();
			assert.equal(d.connects, connects, "the loop stopped: no waiter is left");
			assert.equal(pending.count, 1);
			assert.equal(clock.live.size, 0, "no timer left");
		});
	});

	for (const [what, message, expected] of [
		["a welcome", welcome, (e, d) => { assert.equal(d.links[0].written[1]?.type, "invoke", "welcomed: the invocation is written"); d.links[0].handlers.message(answered(d.links[0].written[1])); return "answered"; }],
		["a refusal", { operationProxy: 1, type: "refused", code: "key-mismatch" }, () => "key-mismatch"],
	]) {
		test(`${what} observed as the client half's clock port throws at a ${at === "read" ? "reading" : "timer's cancellation"} decides as observed`, async () => {
			await noneUnhandled(async () => {
				const clock = faultyClock();
				const d = drivenConnector();
				const pending = watch(call(newClient(d, clock)));
				await turns();
				clock.arm(at);
				assert.doesNotThrow(() => d.links[0].handlers.message(message), "nothing the port throws escapes the link's handler");
				await turns();
				const want = expected(pending.value, d);
				await turns();
				assert.deepEqual(clock.faults, [at], "the port threw");
				assert.equal(want === "answered" ? pending.value?.answer : pending.value?.proxyCode, want === "answered" ? "yes" : want);
				assert.ok(Object.isFrozen(pending.value));
				clock.manual.advance(5000);
				await turns();
				assert.equal(pending.count, 1);
				assert.equal(clock.live.size, 0, "no timer left");
			});
		});
	}

	test(`an unsafe runtime directory observed as the client half's clock port throws at a ${at === "read" ? "reading" : "timer's cancellation"} ends runtime-dir-unsafe at once, for an invocation and for preparing`, async () => {
		await noneUnhandled(async () => {
			const clock = faultyClock();
			const d = drivenConnector(() => "unsafe");
			const c = newClient(d, clock);
			const pending = watch(call(c));
			clock.arm(at);
			await turns();
			assert.deepEqual(clock.faults, [at]);
			assert.deepEqual([pending.value?.ending, pending.value?.proxyCode], ["not-delivered", "runtime-dir-unsafe"]);
			const preparing = watch(c.prepare({ timeMs: 1000 }));
			clock.arm(at);
			await turns();
			assert.deepEqual(clock.faults, [at, at]);
			assert.equal(preparing.value?.proxyCode, "runtime-dir-unsafe");
			clock.manual.advance(5000);
			await turns();
			assert.equal(pending.count + preparing.count, 2);
			assert.equal(clock.live.size, 0, "no timer left");
		});
	});
}

test("preparing settled by a welcome as its clock port throws at a reading, and at a timer's cancellation, is ready once", async () => {
	for (const at of ["read", "cancel"]) {
		await noneUnhandled(async () => {
			const clock = faultyClock();
			const d = drivenConnector();
			const preparing = watch(newClient(d, clock).prepare({ timeMs: 1000 }));
			await turns();
			clock.arm(at);
			d.links[0].handlers.message(welcome);
			await turns();
			assert.deepEqual(clock.faults, [at]);
			assert.equal(preparing.value, "ready", at);
			clock.manual.advance(5000);
			await turns();
			assert.equal(preparing.count, 1);
			assert.equal(clock.live.size, 0);
		});
	}
});

test("with nothing to connect to, a reading that fails launches and waits by the timer alone; a wait that cannot be armed ends the loop, each waiter left to its own deadline", async () => {
	await noneUnhandled(async () => {
		const clock = faultyClock();
		const d = drivenConnector(() => "absent");
		const pending = watch(call(newClient(d, clock), { bound: 1000 }));
		clock.arm("read");
		await turns();
		assert.deepEqual(clock.faults, ["read"]);
		assert.equal(d.launches, 1, "launched though the clock could not be read");
		clock.manual.advance(100);
		await turns();
		assert.equal(d.connects, 2, "connected again after the timer's 100 ms");
		clock.manual.advance(100);
		clock.arm("schedule");
		await turns();
		assert.deepEqual(clock.faults, ["read", "schedule"]);
		const connects = d.connects;
		clock.manual.advance(500);
		await turns();
		assert.equal(d.connects, connects, "no wait could be armed: the loop ended");
		assert.equal(pending.settled, false, "the invocation waits for its own deadline");
		clock.manual.advance(300);
		await turns();
		assert.deepEqual([pending.value?.ending, pending.value?.proxyCode], ["not-delivered", "proxy-unreachable"]);
		assert.equal(clock.live.size, 0);
	});
});

test("the preparer delivers an outcome to every waiter, each on its own: one that throws as it settles keeps no other from its outcome, and the loop's failure goes unobserved nowhere", async () => {
	await noneUnhandled(async () => {
		const clock = createManualHopClock();
		const d = drivenConnector(() => "unsafe");
		const preparer = new Preparer(KEY, d.connector, clock);
		const settled = [];
		preparer.wait({ deadline: clock.nowNs() + 1_000_000_000n, settle: () => { throw new Error("a waiter that throws"); } });
		preparer.wait({ deadline: clock.nowNs() + 1_000_000_000n, settle: (prepared) => settled.push(prepared.kind) });
		await turns();
		assert.deepEqual(settled, ["unsafe"]);
		const failing = new Preparer(KEY, { connect: () => { throw new Error("a connector that throws"); }, launch() { throw new Error("and cannot launch"); } }, { nowNs: () => { throw new Error("nor read"); }, schedule: () => { throw new Error("nor arm a timer"); } });
		failing.wait({ deadline: 1n, settle: () => undefined });
		await turns();
	});
});
