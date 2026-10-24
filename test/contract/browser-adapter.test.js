// browser-adapter - PX8 (zorg's D31, D46, D48, D57, D58; Delta 3, D3-E3): the client half in a browser page
// reaching a SharedWorker named `operation-proxy:<digest>` over one MessagePort per page, carrying PX4's
// messages as plain objects with relative millisecond `deadline` across independent page and worker clocks and
// 5-second `ping` / 15-second liveness heartbeats.
//
// Answers in parts and cancelling (zorg's Delta 4, stage 6, D4-E6): the caller suite's rows `answer-in-parts` and
// `cancel-invocation` run through the browser adapter over a real MessageChannel, the worker's caller
// operation-call's own (PX10); and on a rig whose page side holds or drops what the worker posts, `taken` is
// matched in order across a request's parts and `alive` messages before and after its `end`, a `taken` matching
// nothing or naming another `sequence` closes the port, and a page taking parts, or only `alive` messages, more
// slowly than they are posted has its port closed once 33570816 bytes would be posted and not taken, its call
// cancelled, while a page taking each part in time keeps its port through more than that in all (PX8).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keyDigest } from "@apnex/operation-proxy";
import { createBrowserClient, runBrowserProxy } from "@apnex/operation-proxy/browser";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { CHANNEL_LIMITS } from "@apnex/operation-proxy";
import { browserHarness } from "../support/browser-harness.js";
import { settle, until, watch } from "../support/case-hop.js";
import { KEY } from "../support/hop.js";
import { createManualHopClock, ns } from "../support/manual-hop-clock.js";

/**
 * Opens a browser page client and a SharedWorker proxy with independent clocks (`pageClock` and `workerClock`
 * with different time origins), joined by an in-memory MessagePort pair whose outbound (page -> worker) and
 * return (worker -> page) transits can be delayed or held on a master timeline.
 */
function openBrowserRig({
	key = KEY,
	hopAllowanceMs = 50,
	outboundMs = 0,
	returnMs = 0,
	readiness = Promise.resolve(undefined),
	buildCaller,
	dropPagePings = false,
	dropWorkerPings = false,
	beforePostToWorker,
} = {}) {
	// Different time origins on the page and the worker (PX8).
	const pageClock = createManualHopClock({ start: 10_000_000_000n });
	const workerClock = createManualHopClock({ start: 900_000_000_000n });
	const calls = [];
	const wireToWorker = [];
	const wireToPage = [];
	const workerNames = [];

	const defaultCaller = {
		invoke(call) {
			const invokedAt = workerClock.elapsedMs();
			let resolveCall;
			const promise = new Promise((resolve) => { resolveCall = resolve; });
			const record = {
				call,
				invokedAt,
				bound: call.bound,
				answer: (val = call.input) => resolveCall({
					ending: "answered",
					invocation: call.invocation,
					attempt: `${call.invocation}.00000001`,
					operation: call.operation,
					answer: val,
				}),
				refuse: (refusal) => resolveCall({
					ending: "refused",
					invocation: call.invocation,
					attempt: `${call.invocation}.00000001`,
					operation: call.operation,
					refusal,
				}),
				timeout: () => resolveCall({
					ending: "unknown",
					invocation: call.invocation,
					attempt: `${call.invocation}.00000001`,
					operation: call.operation,
					reason: "bound-passed",
					agpCode: null,
					deliveryReport: "delivered",
				}),
				raw: (val) => resolveCall(val),
			};
			calls.push(record);
			// Schedule the worker call's own bound timer on the worker clock unless the test resolves it first.
			workerClock.schedule(call.bound, () => record.timeout());
			return promise;
		},
	};

	const scope = { onconnect: null };
	const proxy = runBrowserProxy(
		{
			key,
			buildCaller: buildCaller ?? (() => ({ caller: defaultCaller, stop: () => undefined })),
			callerReady: () => readiness,
		},
		{ clock: workerClock, scope },
	);

	/** Advances both independent clocks together in steps of `stepMs` so scheduled transits and timers fire in order. */
	const advanceBoth = async (totalMs, stepMs = 0.5) => {
		let left = totalMs;
		while (left > 1e-9) {
			const d = Math.min(left, stepMs);
			pageClock.advance(d);
			workerClock.advance(d);
			left = Math.round((left - d) * 1e6) / 1e6;
			await settle(2);
		}
	};

	const ports = [];
	const client = createBrowserClient(
		{ key, workerUrl: "https://example.test/zorg-worker.js", hopAllowanceMs },
		{
			clock: pageClock,
			identities: machineIdentities,
			openPort(_url, name) {
				workerNames.push(name);
				const pageListeners = new Set();
				const workerListeners = new Set();
				let closed = false;
				const pagePort = {
					onmessage: null,
					addEventListener(_t, fn) { pageListeners.add(fn); },
					removeEventListener(_t, fn) { pageListeners.delete(fn); },
					start() {},
					close() { closed = true; },
					postMessage(data) {
						if (closed) return;
						if (beforePostToWorker) beforePostToWorker(data, pageClock, workerClock);
						const copy = structuredClone(data);
						wireToWorker.push({ atPageMs: pageClock.elapsedMs(), message: copy });
						if (dropPagePings && copy?.type === "ping") return;
						const deliver = () => {
							if (closed) return;
							for (const fn of [...workerListeners]) fn({ data: copy });
							workerPort.onmessage?.({ data: copy });
						};
						if (outboundMs <= 0) deliver();
						else workerClock.schedule(outboundMs, deliver);
					},
				};
				const workerPort = {
					onmessage: null,
					addEventListener(_t, fn) { workerListeners.add(fn); },
					removeEventListener(_t, fn) { workerListeners.delete(fn); },
					start() {},
					close() { closed = true; },
					postMessage(data) {
						if (closed) return;
						const copy = structuredClone(data);
						wireToPage.push({ atWorkerMs: workerClock.elapsedMs(), message: copy });
						if (dropWorkerPings && copy?.type === "ping") return;
						const deliver = () => {
							if (closed) return;
							for (const fn of [...pageListeners]) fn({ data: copy });
							pagePort.onmessage?.({ data: copy });
						};
						if (returnMs <= 0) deliver();
						else pageClock.schedule(returnMs, deliver);
					},
				};
				ports.push({ pagePort, workerPort });
				scope.onconnect?.({ ports: [workerPort] });
				return pagePort;
			},
		},
	);

	return {
		pageClock,
		workerClock,
		proxy,
		client,
		calls,
		wireToWorker,
		wireToPage,
		workerNames,
		ports,
		advanceBoth,
		close() {
			client.close();
			proxy.close();
		},
	};
}

describe("PX8 - browser adapter (@apnex/operation-proxy/browser, D3-E3)", () => {
	test("connects to SharedWorker named operation-proxy:<digest>; page and worker have different time origins; outbound + return transits < allowance deliver the ending before the page's deadline", async () => {
		const rig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 20, returnMs: 20 });
		try {
			await rig.proxy.ready;
			const w = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input: { x: 1 }, bound: 1000 }));
			await settle(5);
			assert.deepEqual(rig.workerNames, [`operation-proxy:${keyDigest(KEY)}`]);
			// Advance 20 ms for hello -> worker, 20 ms for welcome -> page, 20 ms for invoke -> worker.
			await rig.advanceBoth(60, 5);
			assert.equal(rig.calls.length, 1, "the worker received the invoke");
			assert.equal(rig.calls[0].bound, 910, "remaining time at posting after 40 ms hello+welcome handshake is 950 - 40 = 910 ms");
			rig.calls[0].answer({ ok: true });
			await rig.advanceBoth(25, 5);
			assert.equal(w.settled(), true);
			assert.equal(w.value().ending, "answered");
			assert.deepEqual(w.value().answer, { ok: true });
		} finally {
			rig.close();
		}
	});

	test("an unanswered call with whole-millisecond remaining time whose outbound + return transits together take the allowance or more (each direction alone less) is read at or after the page's deadline and ends hop-stalled", async () => {
		// Allowance 50 ms; outbound 30 ms, return 30 ms (each < 50 ms, sum = 60 ms >= 50 ms).
		const rig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 30, returnMs: 30 });
		try {
			await rig.proxy.ready;
			// Prepare first so the connection is already welcomed at t = 0 of the call.
			const prep = watch(rig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await rig.advanceBoth(60, 5);
			assert.equal(prep.value(), "ready");

			// Now invoke with bound 200 ms (sooner deadline on page is +150 ms; remainingMs at posting is 150 ms).
			// Outbound transit takes 30 ms -> worker receives at +30 ms and binds its call for 150 ms (until +180 ms).
			// At +180 ms the worker's call times out (`bound-passed`), and its return transit takes 30 ms (arriving at +210 ms),
			// which is after the page's +200 ms deadline -> the page ends at +200 ms with `hop-stalled`!
			const w = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "silent", input: null, bound: 200 }));
			await rig.advanceBoth(30, 5);
			assert.equal(rig.calls.length, 1);
			assert.equal(rig.calls[0].bound, 150);
			await rig.advanceBoth(170, 5);
			assert.equal(w.settled(), true, "settled at the page's 200 ms bound");
			assert.deepEqual([w.value().ending, w.value().reason, w.value().attempt], ["unknown", "hop-stalled", null]);
			// When the worker's bound-passed ending arrives 10 ms later at +210 ms, it is discarded.
			await rig.advanceBoth(20, 5);
			assert.equal(w.count(), 1);
			assert.equal(w.value().reason, "hop-stalled");
		} finally {
			rig.close();
		}
	});

	test("transits together longer than the allowance whose early answer still arrives before the page's deadline are taken unchanged", async () => {
		// Allowance 50 ms; outbound 35 ms, return 35 ms (sum = 70 ms > 50 ms), bound 200 ms.
		const rig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 35, returnMs: 35 });
		try {
			await rig.proxy.ready;
			await rig.advanceBoth(10, 5);
			const prep = watch(rig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await rig.advanceBoth(70, 5);
			assert.equal(prep.value(), "ready");

			const w = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input: "fast", bound: 200 }));
			await rig.advanceBoth(35, 5);
			assert.equal(rig.calls.length, 1);
			// Worker answers after 10 ms (at +45 ms); return transit of 35 ms delivers at +80 ms < 200 ms!
			await rig.advanceBoth(10, 5);
			rig.calls[0].answer("fast-answer");
			await settle(5);
			await rig.advanceBoth(35, 5);
			assert.equal(w.settled(), true);
			assert.deepEqual([w.value().ending, w.value().answer], ["answered", "fast-answer"]);
		} finally {
			rig.close();
		}
	});

	test("an outbound transit crossing a whole millisecond of the worker's flooring, and an answer arriving in the interval the outbound transit adds to the worker's call, is taken", async () => {
		// Page posts after 0.4 ms of checking on a 100 ms bound (allowance 50 ms -> sooner = 50 ms, remainingMs = 49.6 ms -> worker floors to 49 ms).
		// Outbound transit is 15.7 ms -> worker receives at +16.1 ms and runs its call for 49 ms (until +65.1 ms).
		// Answer produced at +60 ms (in the interval [50 ms, 65.1 ms] that outbound transit added!) with 10 ms return transit arrives at +70 ms < 100 ms -> taken!
		const rig = openBrowserRig({
			hopAllowanceMs: 50,
			outboundMs: 15.7,
			returnMs: 10,
		});
		try {
			await rig.proxy.ready;
			const prep = watch(rig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await rig.advanceBoth(30, 1);
			assert.equal(prep.value(), "ready");

			const input = {
				get v() {
					rig.pageClock.move(0.4);
					return "crossed";
				},
			};
			const w = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input, bound: 100 }));
			await rig.advanceBoth(16, 0.5);
			assert.equal(rig.calls.length, 1);
			assert.equal(rig.calls[0].bound, 49, "worker floored 49.6 ms to 49 ms");
			// Advance 44 ms more (to ~60.1 ms total elapsed on page, past the 50 ms sooner mark, but within worker's +16.1 + 49 = 65.1 ms bound!).
			await rig.advanceBoth(44, 1);
			assert.equal(w.settled(), false);
			rig.calls[0].answer("in-added-interval");
			await settle(5);
			await rig.advanceBoth(10, 1);
			assert.equal(w.settled(), true);
			assert.deepEqual([w.value().ending, w.value().answer], ["answered", "in-added-interval"]);
		} finally {
			rig.close();
		}
	});

	test("a message delayed past the page's deadline still starts its call when remainingMs >= 1 at posting, and its ending is discarded after the page ended hop-stalled", async () => {
		// Bound 50 ms (allowance 25 ms -> remainingMs = 25 ms at posting), outbound transit 80 ms (arrives after the page's 50 ms deadline!).
		const rig = openBrowserRig({ hopAllowanceMs: 25, outboundMs: 80, returnMs: 5 });
		try {
			await rig.proxy.ready;
			const prep = watch(rig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await rig.advanceBoth(90, 5);
			assert.equal(prep.value(), "ready");

			const w = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input: "delayed", bound: 50 }));
			await rig.advanceBoth(50, 5);
			assert.equal(w.settled(), true, "page deadline passed at 50 ms");
			assert.deepEqual([w.value().ending, w.value().reason], ["unknown", "hop-stalled"]);
			assert.equal(rig.calls.length, 0, "invoke has not yet arrived at the worker");

			// At +80 ms the invoke arrives at the worker with remainingMs = 25 >= 1, so the worker still admits it!
			await rig.advanceBoth(30, 5);
			assert.equal(rig.calls.length, 1, "worker admitted the delayed message because remainingMs >= 1 at posting");
			rig.calls[0].answer("too-late");
			await rig.advanceBoth(10, 5);
			assert.equal(w.count(), 1);
			assert.equal(w.value().reason, "hop-stalled", "page discarded the late ending");
		} finally {
			rig.close();
		}
	});

	test("a bound of 2 milliseconds posted with remaining time just below 1 ms is refused deadline-passed, while one posted with remaining time >= 1 ms is admitted even with a positive transit; a bound passing before posting ends bound-passed", async () => {
		const rig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 0.4, returnMs: 0.4 });
		try {
			await rig.proxy.ready;
			const prep = watch(rig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await rig.advanceBoth(10, 1);
			assert.equal(prep.value(), "ready");

			// 1. Bound 2 ms -> allowance = min(50, floor(2/2)) = 1 ms -> sooner = +1 ms.
			// Input getter moves page clock by 0.2 ms -> remainingMs at posting is 0.8 ms (< 1 ms) -> refused deadline-passed!
			const belowOne = watch(rig.client.invoke({
				host: "host-a",
				service: "svc",
				operation: "echo",
				input: { get x() { rig.pageClock.move(0.2); return 1; } },
				bound: 2,
			}));
			await rig.advanceBoth(1, 0.2);
			assert.equal(belowOne.settled(), true);
			assert.deepEqual([belowOne.value().ending, belowOne.value().proxyCode], ["not-delivered", "deadline-passed"]);
			assert.equal(rig.calls.length, 0, "worker did not invoke the caller for remainingMs < 1");

			// 2. Bound 2 ms with 0 ms elapsed before posting -> remainingMs = 1.0 ms -> admitted even after 5 ms outbound transit!
			const exactOne = watch(rig.client.invoke({
				host: "host-a",
				service: "svc",
				operation: "echo",
				input: { x: 2 },
				bound: 2,
			}));
			// With bound 2 ms and outboundMs 0.4 ms, returnMs 0.4 ms, the worker receives remainingMs = 1, admits it, and answers before the 2 ms deadline.
			await rig.advanceBoth(0.5, 0.1);
			assert.equal(rig.calls.length, 1, "worker admitted remainingMs === 1 despite positive outbound transit");
			assert.equal(rig.calls[0].bound, 1);
			rig.calls[0].answer("one-ms-ok");
			await settle(5);
			await rig.advanceBoth(0.5, 0.1);
			assert.deepEqual([exactOne.value().ending, exactOne.value().answer], ["answered", "one-ms-ok"]);

			// 3. Bound 20 ms with outboundMs 5 ms, returnMs 1 ms -> remainingMs = 10 ms >= 1 -> answered!
			const answered = watch(rig.client.invoke({
				host: "host-a",
				service: "svc",
				operation: "echo",
				input: { x: 3 },
				bound: 20,
			}));
			await rig.advanceBoth(0.5, 0.1);
			assert.equal(rig.calls.length, 2);
			rig.calls[1].answer("ok");
			await settle(5);
			await rig.advanceBoth(0.5, 0.1);
			assert.deepEqual([answered.value().ending, answered.value().answer], ["answered", "ok"]);

			// 4. Bound passing during input check before posting -> ends `bound-passed` with nothing posted.
			const beforeCount = rig.wireToWorker.length;
			const passedBeforePost = await rig.client.invoke({
				host: "host-a",
				service: "svc",
				operation: "echo",
				input: { get x() { rig.pageClock.move(5); return 1; } },
				bound: 5,
			});
			assert.deepEqual([passedBeforePost.ending, passedBeforePost.reason], ["unknown", "bound-passed"]);
			assert.equal(rig.wireToWorker.length, beforeCount, "nothing posted when bound passed while checking");
		} finally {
			rig.close();
		}
	});

	test("D58, PX8: pre-welcome ping keeps a preparation lasting longer than 5 seconds alive until welcome; ping every 5 s keeps an idle port alive past 15 s; a peer silent for 15 s ends written invocations unknown with proxy-lost", async () => {
		let releaseReady;
		const readiness = new Promise((resolve) => { releaseReady = () => resolve(undefined); });
		const rig = openBrowserRig({ readiness });
		try {
			// 1. Preparation lasting 12 seconds (> 5 s): pre-welcome pings are exchanged at 5 s and 10 s without closing the connection!
			const prep = watch(rig.client.prepare({ timeMs: 20_000 }));
			await rig.advanceBoth(12_000, 500);
			assert.equal(prep.settled(), false, "still preparing at 12 s");
			assert.ok(rig.wireToWorker.filter((w) => w.message.type === "ping").length >= 2, "page sent pre-welcome pings");
			assert.ok(rig.wireToPage.filter((w) => w.message.type === "ping").length >= 2, "worker sent pre-welcome pings");
			releaseReady();
			await settle(10);
			assert.equal(prep.value(), "ready", "welcomed after 12 s preparation");

			// 2. Idle port stays alive across 25 seconds (> 15 s liveness timeout) thanks to 5 s pings.
			await rig.advanceBoth(25_000, 1000);
			const ask = watch(rig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input: "alive", bound: 2000 }));
			await settle(5);
			assert.equal(rig.calls.length, 1);
			rig.calls[0].answer("still-alive");
			await settle(5);
			assert.deepEqual([ask.value().ending, ask.value().answer], ["answered", "still-alive"]);
		} finally {
			rig.close();
		}

		// 3. Silent worker (worker pings dropped): written invocation with a 30 s bound ends `unknown` with `proxy-lost` at 15 s!
		const silentRig = openBrowserRig({ dropWorkerPings: true });
		try {
			await silentRig.proxy.ready;
			const prep = watch(silentRig.client.prepare({ timeMs: 1000 }));
			await settle(10);
			assert.equal(prep.value(), "ready");

			const call = watch(silentRig.client.invoke({ host: "host-a", service: "svc", operation: "silent", input: null, bound: 30_000 }));
			await settle(5);
			await silentRig.advanceBoth(14_900, 500);
			assert.equal(call.settled(), false, "alive at 14.9 s");
			await silentRig.advanceBoth(200, 100);
			assert.equal(call.settled(), true, "closed at 15 s of silence");
			assert.deepEqual([call.value().ending, call.value().reason, call.value().attempt], ["unknown", "proxy-lost", null]);
		} finally {
			silentRig.close();
		}
	});

	test("PX8, F4: unanswered calls with total transits just below (48 ms < 50 ms), equal to (50 ms === 50 ms), and above (60 ms > 50 ms) the hop allowance, and independent page and worker wall clocks", async () => {
		// 1. Just below the allowance: allowance 50 ms, outbound 24 ms + return 24 ms = 48 ms < 50 ms.
		// Bound 200 ms -> sooner = 150 ms -> worker call bound = 150 ms.
		// Worker receives at +24 ms, times out at +174 ms (`bound-passed` with deliveryReport "delivered"),
		// and return transit of 24 ms delivers at +198 ms < 200 ms -> page takes `bound-passed` with deliveryReport!
		const belowRig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 24, returnMs: 24 });
		try {
			await belowRig.proxy.ready;
			const prep = watch(belowRig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await belowRig.advanceBoth(48, 4);
			assert.equal(prep.value(), "ready");

			const w = watch(belowRig.client.invoke({ host: "host-a", service: "svc", operation: "silent", input: null, bound: 200 }));
			await belowRig.advanceBoth(174, 2);
			// Let the worker timeout promise settle before advancing the return transit!
			await settle(5);
			await belowRig.advanceBoth(24, 2);
			assert.equal(w.settled(), true);
			assert.deepEqual([w.value().ending, w.value().reason, w.value().deliveryReport], ["unknown", "bound-passed", "delivered"], "48 ms total transit < 50 ms allowance delivers bound-passed in time");
		} finally {
			belowRig.close();
		}

		// 1b. Independent page and worker wall clocks stepped in opposite directions (+3_600_000 ms on page, -3_600_000 ms on worker) while a call is in flight:
		// monotonic deadline calculation on each side is unaffected, and the page's invocation identity uses the page's wall clock.
		let pageWallMs = 1_800_000_000_000;
		let workerWallMs = 1_600_000_000_000;
		const origDateNow = Date.now;
		const wallRig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 10, returnMs: 10 });
		try {
			await wallRig.proxy.ready;
			const prep = watch(wallRig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await wallRig.advanceBoth(20, 2);
			assert.equal(prep.value(), "ready");
			Date.now = () => pageWallMs;
			const wallCall = watch(wallRig.client.invoke({ host: "host-a", service: "svc", operation: "echo", input: "wall", bound: 200 }));
			await settle(5);
			// Step page wall clock forward 1 hour and worker wall clock backward 1 hour while the call is in transit.
			pageWallMs += 3_600_000;
			workerWallMs -= 3_600_000;
			Date.now = () => workerWallMs;
			await wallRig.advanceBoth(10, 2);
			assert.equal(wallRig.calls.length, 1);
			assert.equal(wallRig.calls[0].bound, 150, "worker bound unaffected by opposite wall-clock shifts");
			wallRig.calls[0].answer("wall-ok");
			await settle(5);
			await wallRig.advanceBoth(10, 2);
			assert.equal(wallCall.settled(), true);
			assert.deepEqual([wallCall.value().ending, wallCall.value().answer], ["answered", "wall-ok"]);
		} finally {
			Date.now = origDateNow;
			wallRig.close();
		}

		// 2. Equal to the allowance: allowance 50 ms, outbound 25 ms + return 25 ms = 50 ms === 50 ms.
		// Worker receives at +25 ms, times out at +175 ms, and return transit of 25 ms arrives at +200 ms (at the page's deadline) -> loses to the page's deadline (`hop-stalled`)!
		const equalRig = openBrowserRig({ hopAllowanceMs: 50, outboundMs: 25, returnMs: 25 });
		try {
			await equalRig.proxy.ready;
			const prep = watch(equalRig.client.prepare({ timeMs: 500 }));
			await settle(5);
			await equalRig.advanceBoth(50, 5);
			assert.equal(prep.value(), "ready");

			const w = watch(equalRig.client.invoke({ host: "host-a", service: "svc", operation: "silent", input: null, bound: 200 }));
			await equalRig.advanceBoth(175, 5);
			await settle(5);
			await equalRig.advanceBoth(25, 5);
			assert.equal(w.settled(), true);
			assert.deepEqual([w.value().ending, w.value().reason, w.value().attempt], ["unknown", "hop-stalled", null], "50 ms total transit === 50 ms allowance arrives at deadline and ends hop-stalled");
		} finally {
			equalRig.close();
		}
	});

	test("PX8, F1, F2: advancing worker clock (1000 ns per read) floors once (1 ms admitted and 49.6 ms -> 49 ms), and default browser clock and identities work with fractional performance.now()", async () => {
		// 1. Worker clock advancing 1000 ns (0.001 ms) on every nowNs() read (F2).
		let workerBaseNs = 900_000_000_000n;
		const manualWorker = createManualHopClock({ start: workerBaseNs });
		const steppingWorkerClock = {
			nowNs: () => {
				workerBaseNs += 1_000n;
				manualWorker.move(0.001);
				return manualWorker.nowNs();
			},
			schedule: (ms, fn) => manualWorker.schedule(ms, fn),
		};
		const pageClock = createManualHopClock({ start: 10_000_000_000n });
		const recordedBounds = [];
		const scope = { onconnect: null };
		const proxy = runBrowserProxy(
			{
				key: KEY,
				buildCaller: () => ({
					caller: {
						invoke(call) {
							recordedBounds.push(call.bound);
							return Promise.resolve({
								ending: "answered",
								invocation: call.invocation,
								attempt: `${call.invocation}.00000001`,
								operation: call.operation,
								answer: call.bound,
							});
						},
					},
					stop: () => undefined,
				}),
				callerReady: () => undefined,
			},
			{ clock: steppingWorkerClock, scope },
		);
		await proxy.ready;
		const client = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/w.js", hopAllowanceMs: 50 },
			{
				clock: pageClock,
				identities: { wallTimeMs: () => 1_700_000_000_000, randomHex: (n) => "b".repeat(n) },
				openPort() {
					let pHandler;
					let wHandler;
					const pagePort = {
						postMessage(m) {
							const copy = structuredClone(m);
							manualWorker.schedule(0.2, () => wHandler?.({ data: copy }));
						},
						addEventListener(_t, fn) { pHandler = fn; },
						removeEventListener() {},
						start() {},
						close() {},
					};
					const workerPort = {
						postMessage(m) {
							const copy = structuredClone(m);
							pageClock.schedule(0.2, () => pHandler?.({ data: copy }));
						},
						addEventListener(_t, fn) { wHandler = fn; },
						removeEventListener() {},
						start() {},
						close() {},
					};
					scope.onconnect({ ports: [workerPort] });
					return pagePort;
				},
			},
		);
		const stepBoth = async (ms) => {
			for (let i = 0; i < Math.round(ms / 0.1); i++) {
				pageClock.advance(0.1);
				manualWorker.advance(0.1);
				await settle(2);
			}
		};
		const prep = watch(client.prepare({ timeMs: 100 }));
		await settle(5);
		await stepBoth(1);
		assert.equal(prep.value(), "ready");

		// Bound 2 ms -> allowance 1 ms -> remainingMs 1 ms at posting, with stepping worker clock and 0.2 ms transits: admitted with bound 1!
		const oneMs = watch(client.invoke({ host: "host-a", service: "svc", operation: "echo", input: 1, bound: 2 }));
		await stepBoth(1);
		assert.equal(oneMs.settled(), true);
		assert.deepEqual([oneMs.value().ending, oneMs.value().answer], ["answered", 1]);

		// Bound 100 ms with 0.4 ms input read -> remainingMs 49.6 ms at posting -> worker receives bound 49 (not 48!).
		const fortyNine = watch(client.invoke({
			host: "host-a",
			service: "svc",
			operation: "echo",
			input: { get x() { pageClock.move(0.4); return 1; } },
			bound: 100,
		}));
		await stepBoth(1);
		assert.equal(fortyNine.settled(), true);
		assert.deepEqual([fortyNine.value().ending, fortyNine.value().answer], ["answered", 49]);
		assert.deepEqual(recordedBounds, [1, 49]);
		client.close();
		proxy.close();

		// 2. Default browser clock and default identities with real fractional performance.now() (F1).
		const defaultScope = { onconnect: null };
		const defaultProxy = runBrowserProxy(
			{
				key: KEY,
				buildCaller: () => ({
					caller: {
						invoke: (call) => Promise.resolve({
							ending: "answered",
							invocation: call.invocation,
							attempt: `${call.invocation}.00000001`,
							operation: call.operation,
							answer: "default-clock-ok",
						}),
					},
				}),
				callerReady: () => undefined,
			},
			{ scope: defaultScope },
		);
		await defaultProxy.ready;
		const defaultClient = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/default.js" },
			{
				openPort() {
					let pFn;
					let wFn;
					const pPort = { postMessage: (m) => wFn?.({ data: structuredClone(m) }), addEventListener: (_t, fn) => { pFn = fn; } };
					const wPort = { postMessage: (m) => pFn?.({ data: structuredClone(m) }), addEventListener: (_t, fn) => { wFn = fn; } };
					defaultScope.onconnect({ ports: [wPort] });
					return pPort;
				},
			},
		);
		const res = await defaultClient.invoke({ host: "host-a", service: "svc", operation: "echo", input: null, bound: 1000 });
		assert.deepEqual([res.ending, res.answer], ["answered", "default-clock-ok"]);
		defaultClient.close();
		defaultProxy.close();
	});
});

// ---------------------------------------------------------------------------------------------------------
// Answers in parts and cancelling through the browser adapter (PX8, PX10; zorg's Delta 4, stage 6, D4-E6).

registerCallerSuite((name, run) => test(`D4-E6, through the browser adapter, an allowance of 50 ms: ${name}`, { timeout: 120_000 }, run), browserHarness({ allowanceMs: 50 }), ["answer-in-parts", "cancel-invocation"]);

/**
 * A page and a worker on manual clocks of different origins, moved together by `advance`, joined by an in-memory
 * port pair: what the worker posts reaches the
 * page a turn later unless the case holds it (`hold`, released by `release`) or drops it (`drop`), each by type;
 * what the page posts reaches the worker a turn later, recorded. Closing one port closes neither the other nor what
 * was already posted to it. The worker's caller is the case's: each call is recorded with `part(answer)`, which
 * gives the next part to its `onPart`, and `end(answer)`, which answers it.
 */
function partsRig({ hopAllowanceMs = 50 } = {}) {
	const pageClock = createManualHopClock({ start: 10_000_000_000n });
	const workerClock = createManualHopClock({ start: 900_000_000_000n });
	const calls = [];
	const toWorker = [];
	const toPage = [];
	const held = [];
	const policy = { hold: new Set(), drop: new Set() };
	let workerClosed = false;
	let pageClosed = false;
	const pageListeners = new Set();
	const workerListeners = new Set();
	const turn = (fn) => setImmediate(fn);
	const deliverToPage = (data) => {
		if (pageClosed) return;
		for (const fn of [...pageListeners]) fn({ data });
	};
	const workerPort = {
		addEventListener: (_t, fn) => workerListeners.add(fn),
		removeEventListener: (_t, fn) => workerListeners.delete(fn),
		start() {},
		close() { workerClosed = true; },
		postMessage(data) {
			if (workerClosed) return;
			const copy = structuredClone(data);
			toPage.push(copy);
			if (policy.drop.has(copy.type)) return;
			if (policy.hold.has(copy.type)) return void held.push(copy);
			turn(() => deliverToPage(copy));
		},
	};
	const pagePort = {
		addEventListener: (_t, fn) => pageListeners.add(fn),
		removeEventListener: (_t, fn) => pageListeners.delete(fn),
		start() {},
		close() { pageClosed = true; },
		postMessage(data) {
			if (pageClosed) return;
			const copy = structuredClone(data);
			toWorker.push(copy);
			turn(() => { if (!workerClosed) for (const fn of [...workerListeners]) fn({ data: copy }); });
		},
	};
	const caller = {
		invoke(call) {
			let sequence = 0;
			let resolve;
			const ending = new Promise((r) => { resolve = r; });
			calls.push({
				call,
				part: (answer) => call.onPart({ sequence: ++sequence, answer }),
				end: (answer) => resolve({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000001`, operation: call.operation, answer }),
			});
			return ending;
		},
	};
	const proxy = runBrowserProxy({ key: KEY, buildCaller: () => ({ caller, stop: () => undefined }), callerReady: () => undefined }, { clock: workerClock, scope: {} });
	const client = createBrowserClient({ key: KEY, workerUrl: "https://example.test/worker.js", hopAllowanceMs }, {
		clock: pageClock, identities: machineIdentities, openPort() { proxy.connectPort(workerPort); return pagePort; },
	});
	return {
		pageClock, workerClock, calls, toWorker, toPage, policy, proxy, client, workerPort,
		/** Moves both clocks by `ms` in steps of `by`, letting what each step posted cross, as time passing does. */
		async advance(ms, by = 25) {
			for (let left = ms; left > 0; left -= by) {
				const d = Math.min(by, left);
				workerClock.advance(d);
				pageClock.advance(d);
				await settle(2);
			}
		},
		workerClosed: () => workerClosed,
		/** Delivers what was held to the page, in order. */
		release() { for (const data of held.splice(0)) turn(() => deliverToPage(data)); },
		/** Posts a raw message to the worker, as from the page. */
		postToWorker: (message) => pagePort.postMessage(message),
		call: (request) => client.invoke({ host: "host-a", service: "fixture", operation: "op", input: {}, bound: 1000, ...request }),
		close() { client.close(); proxy.close(); },
	};
}

test("PX8 (D4-E6): with page and worker on clocks of different origins, the page's deadline is moved by each part and alive it reads, and it posts taken for each, matched by the worker in order across a request's parts and alive messages before and after its end; a taken matching nothing, or naming another sequence, closes the port", async () => {
	const r = partsRig();
	try {
		await r.proxy.ready;
		const parts = [];
		const call = watch(r.call({ onPart: (p) => { parts.push(p.answer); } }));
		await until(() => r.calls.length === 1, "the worker's call made");
		assert.equal(r.toWorker.find((m) => m.type === "invoke").parts, true, "invoke carries parts");
		assert.equal(r.calls[0].call.bound, 950, "the worker's call bound 950 on its own clock, so its alive every 475");
		r.policy.hold.add("part").add("alive").add("end");
		r.calls[0].part("one");
		r.calls[0].part("two");
		await r.advance(475);
		r.calls[0].part("three");
		await settle();
		assert.deepEqual(r.toPage.filter((m) => ["part", "alive", "end"].includes(m.type)).map((m) => m.type), ["part", "part", "alive", "part"], "posted while the page holds them");
		r.policy.hold.clear();
		r.release();
		await until(() => parts.length === 3, "the parts read at 475");
		// The alive at 950 and the end are held, so the alive's taken reaches the worker after it posted the end.
		r.policy.hold.add("alive").add("end");
		await r.advance(700);
		assert.ok(!call.settled(), "at 1175, past the page's first deadline of 1000, the signs of life it read at 475 moved it to 1475");
		r.calls[0].end("done");
		await settle();
		assert.deepEqual(r.toPage.filter((m) => ["alive", "end"].includes(m.type)).map((m) => m.type).slice(-2), ["alive", "end"]);
		r.policy.hold.clear();
		r.release();
		await until(call.settled, "the ending read");
		assert.equal(call.value().answer, "done");
		assert.deepEqual(parts, ["one", "two", "three"]);
		await settle();
		assert.deepEqual(r.toWorker.filter((m) => m.type === "taken"), [
			{ operationProxy: 1, type: "taken", request: 1, sequence: 1 },
			{ operationProxy: 1, type: "taken", request: 1, sequence: 2 },
			{ operationProxy: 1, type: "taken", request: 1 },
			{ operationProxy: 1, type: "taken", request: 1, sequence: 3 },
			{ operationProxy: 1, type: "taken", request: 1 },
		], "a taken for each part and alive, in order, none for the end");
		assert.equal(r.workerClosed(), false, "each matched, after the end too");
		const next = watch(r.call({}));
		await until(() => r.calls.length === 2, "a second call on the same port");
		r.calls[1].end("again");
		await until(next.settled, "its ending");
		assert.equal(next.value().answer, "again", "the port kept");
	} finally {
		r.close();
	}
	for (const [what, taken] of [["a taken matching nothing", { operationProxy: 1, type: "taken", request: 99 }], ["a taken naming another sequence", { operationProxy: 1, type: "taken", request: 1, sequence: 2 }], ["a taken with no sequence for a part", { operationProxy: 1, type: "taken", request: 1 }]]) {
		const r2 = partsRig();
		try {
			await r2.proxy.ready;
			watch(r2.call({ onPart: () => undefined }));
			await until(() => r2.calls.length === 1, "the worker's call made");
			r2.policy.drop.add("part");
			r2.calls[0].part("unread");
			r2.postToWorker(taken);
			await until(r2.workerClosed, `${what}: the port closed`);
			await until(() => r2.calls[0].call.signal.aborted, `${what}: the call in parts aborted`);
		} finally {
			r2.close();
		}
	}
});

test("PX8 (D4-E6): a page taking parts more slowly than they are posted has its port closed once 33570816 bytes would be posted and not taken, its call aborted; an end posted before the close is still read", { timeout: 120_000 }, async () => {
	const r = partsRig();
	try {
		await r.proxy.ready;
		const first = watch(r.call({}));
		await until(() => r.calls.length === 1, "the first call made");
		r.policy.hold.add("part").add("end");
		r.calls[0].end("posted before the close");
		const parts = [];
		const flood = watch(r.call({ bound: 600_000, onPart: (p) => { parts.push(p.sequence); } }));
		await until(() => r.calls.length === 2, "the call in parts made");
		const text = "z".repeat(1_000_000);
		let posted = 0;
		for (let i = 0; i < 40 && !r.workerClosed(); i++) {
			r.calls[1].part({ i, text });
			if (!r.workerClosed()) posted++;
		}
		assert.ok(r.workerClosed(), "the port closed");
		const partBytes = Buffer.byteLength(JSON.stringify({ operationProxy: 1, type: "part", request: 2, sequence: 1, answer: { i: 0, text } }), "utf8");
		assert.equal(posted, Math.floor(CHANNEL_LIMITS.unwrittenBytes / partBytes), `parts posted until the next would pass ${CHANNEL_LIMITS.unwrittenBytes} bytes not taken`);
		assert.equal(r.toPage.filter((m) => m.type === "part").length, posted, "the part that would pass it not posted");
		await until(() => r.calls[1].call.signal.aborted, "the call in parts aborted");
		r.policy.hold.clear();
		r.release();
		await until(first.settled, "the end posted before the close read");
		assert.equal(first.value().answer, "posted before the close");
		assert.ok(!flood.settled() || flood.value().ending === "unknown", "the call in parts never answered");
	} finally {
		r.close();
	}
});

test("PX8 (D4-E6): a page taking only alive messages more slowly than they are posted, during a quiet invocation in parts, has its port closed once 33570816 bytes would be posted and not taken, its call aborted", { timeout: 300_000 }, async () => {
	const r = partsRig();
	try {
		await r.proxy.ready;
		// A raw page: it says hello, invokes with 2 ms left, and then only pings, taking no alive.
		r.proxy.connectPort(r.workerPort);
		r.postToWorker({ operationProxy: 1, type: "hello", key: KEY });
		await until(() => r.toPage.some((m) => m.type === "welcome"), "welcome");
		r.policy.drop.add("alive");
		r.postToWorker({ operationProxy: 1, type: "invoke", request: 1, invocation: "1791540000000-0123456789abcdef", host: "host-a", service: "fixture", operation: "op", input: {}, deadline: 2, repeat: false, aborted: false, parts: true });
		await until(() => r.calls.length === 1, "the worker's call made");
		assert.equal(r.calls[0].call.bound, 2, "its call bound 2 ms, so an alive every 1 ms");
		const aliveBytes = Buffer.byteLength(JSON.stringify({ operationProxy: 1, type: "alive", request: 1 }), "utf8");
		const limit = Math.floor(CHANNEL_LIMITS.unwrittenBytes / aliveBytes);
		for (let elapsed = 0; !r.workerClosed() && elapsed < limit + 20_000; elapsed += 5000) {
			r.workerClock.advance(5000);
			r.pageClock.advance(5000);
			r.postToWorker({ operationProxy: 1, type: "ping" });
			await settle(2);
		}
		assert.ok(r.workerClosed(), "the port closed");
		assert.equal(r.toPage.filter((m) => m.type === "alive").length, limit, `alive messages posted until the next would pass ${CHANNEL_LIMITS.unwrittenBytes} bytes not taken`);
		await until(() => r.calls[0].call.signal.aborted, "the call in parts aborted");
	} finally {
		r.close();
	}
});

test("PX8 (D4-E6): a page taking each part in time keeps its port while more than 33570816 bytes in all are posted", { timeout: 120_000 }, async () => {
	const r = partsRig();
	try {
		await r.proxy.ready;
		const parts = [];
		const call = watch(r.call({ bound: 600_000, onPart: (p) => { parts.push(p.sequence); } }));
		await until(() => r.calls.length === 1, "the worker's call made");
		const text = "w".repeat(1_000_000);
		for (let i = 0; i < 40; i++) {
			r.calls[0].part({ i, text });
			await until(() => r.toWorker.filter((m) => m.type === "taken").length === i + 1, `part ${i + 1} taken`);
		}
		r.calls[0].end("all");
		await until(call.settled, "the ending");
		assert.equal(call.value().answer, "all");
		assert.equal(parts.length, 40);
		assert.equal(r.workerClosed(), false, "the port kept");
	} finally {
		r.close();
	}
});

test("PX8, PX9 (D8-E1): browser client.status never constructs a SharedWorker when neither openStatusPort nor openPort is supplied, prefers openStatusPort over openPort, maps null/throw/rejection to stopped, carries BrowserProxiedCaller.status(), and crosses 5 s and 15 s boundaries without posting ping or expiring at 15 s", async () => {
	// 1. Default browser client (no openStatusPort or openPort): SharedWorker constructor spy sees 0 constructions on status().
	let constructed = 0;
	const origSharedWorker = globalThis.SharedWorker;
	globalThis.SharedWorker = class FakeSharedWorker {
		constructor() {
			constructed++;
			this.port = { postMessage() {}, start() {}, close() {} };
		}
	};
	try {
		const defaultClient = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/worker.js" },
			{ clock: createManualHopClock(), identities: machineIdentities },
		);
		const res = await defaultClient.status({ timeMs: 1000 });
		assert.deepEqual(res, { state: "stopped" });
		assert.equal(constructed, 0, "status() never constructs a SharedWorker");
	} finally {
		if (origSharedWorker === undefined) delete globalThis.SharedWorker;
		else globalThis.SharedWorker = origSharedWorker;
	}

	// 2. openStatusPort precedence over openPort, and openStatusPort / openPort returning null, throwing, or rejecting -> { state: "stopped" }.
	for (const hookOutcome of ["null", "throw", "reject"]) {
		let openPortCalls = 0;
		let statusPortCalls = 0;
		const cl = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/worker.js" },
			{
				clock: createManualHopClock(),
				identities: machineIdentities,
				openPort() { openPortCalls++; throw new Error("should not call openPort when openStatusPort is given"); },
				openStatusPort() {
					statusPortCalls++;
					if (hookOutcome === "null") return null;
					if (hookOutcome === "throw") {
						const e = new Error("status-hook-throw");
						e.p = Promise.reject(new Error("observed-sync"));
						throw e;
					}
					return Promise.reject(Object.assign(new Error("status-hook-reject"), { p: Promise.reject(new Error("observed-async")) }));
				},
			},
		);
		assert.deepEqual(await cl.status({ timeMs: 500 }), { state: "stopped" });
		assert.equal(statusPortCalls, 1);
		assert.equal(openPortCalls, 0);
	}

	// 3. openPort fallback when openStatusPort is omitted, BrowserProxiedCaller.status() callback (including D54/D55 protection), and delayed probe crossing 5 s and 15 s boundaries.
	const pageClock = createManualHopClock();
	const workerClock = createManualHopClock();
	const scope = { onconnect: null };
	let workerStatus = () => ({ workerNode: "browser-1", connected: true });
	const proxy = runBrowserProxy(
		{
			key: KEY,
			buildCaller: () => ({
				caller: { invoke: () => new Promise(() => {}) },
				status: () => workerStatus(),
			}),
			callerReady: () => undefined,
		},
		{ clock: workerClock, scope },
	);
	try {
		await proxy.ready;
		let outboundDelayMs = 0;
		let returnDelayMs = 0;
		let dropReply = false;
		const postedByPage = [];
		let lastClosed = false;
		const makePort = () => {
			const pageListeners = new Set();
			const workerListeners = new Set();
			let closed = false;
			lastClosed = false;
			const pagePort = {
				onmessage: null,
				addEventListener(_t, fn) { pageListeners.add(fn); },
				removeEventListener(_t, fn) { pageListeners.delete(fn); },
				start() {},
				close() { closed = true; lastClosed = true; },
				postMessage(data) {
					if (closed) return;
					const copy = structuredClone(data);
					postedByPage.push({ atMs: pageClock.elapsedMs(), message: copy });
					const deliver = () => {
						if (closed) return;
						for (const fn of [...workerListeners]) fn({ data: copy });
						workerPort.onmessage?.({ data: copy });
					};
					if (outboundDelayMs <= 0) deliver();
					else workerClock.schedule(outboundDelayMs, deliver);
				},
			};
			const workerPort = {
				onmessage: null,
				addEventListener(_t, fn) { workerListeners.add(fn); },
				removeEventListener(_t, fn) { workerListeners.delete(fn); },
				start() {},
				close() {},
				postMessage(data) {
					if (closed) return;
					const copy = structuredClone(data);
					if (dropReply && copy?.type === "status") return;
					const deliver = () => {
						if (closed) return;
						for (const fn of [...pageListeners]) fn({ data: copy });
						pagePort.onmessage?.({ data: copy });
					};
					if (returnDelayMs <= 0) deliver();
					else pageClock.schedule(returnDelayMs, deliver);
				},
			};
			scope.onconnect?.({ ports: [workerPort] });
			return pagePort;
		};
		let usedStatusHook = 0;
		const client = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/worker.js" },
			{
				clock: pageClock,
				identities: machineIdentities,
				openPort: () => { throw new Error("openStatusPort should take precedence"); },
				openStatusPort: () => { usedStatusHook++; return makePort(); },
			},
		);
		const st1 = await client.status({ timeMs: 1000 });
		assert.deepEqual(st1, {
			state: "running",
			ready: true,
			connections: 0,
			inFlight: 0,
			target: { workerNode: "browser-1", connected: true },
		});
		assert.equal(usedStatusHook, 1);
		assert.equal(lastClosed, true, "status port closed on settlement");

		// D54/D55 protection on BrowserProxiedCaller.status():
		let getterCalled = 0;
		const badObj = {};
		Object.defineProperty(badObj, "a", { enumerable: true, get() { getterCalled++; return 1; } });
		workerStatus = () => badObj;
		const stBad = await client.status({ timeMs: 1000 });
		assert.equal(stBad.target, null);
		assert.equal(getterCalled, 0);
		workerStatus = () => ({ workerNode: "browser-1", connected: true });

		// Delayed probe with timeMs: 20_000 and returnDelayMs: 16_000 crosses 5 s and 15 s boundaries without posting ping or expiring at 15 s:
		postedByPage.length = 0;
		returnDelayMs = 16_000;
		const delayed = watch(client.status({ timeMs: 20_000 }));
		await settle();
		for (let elapsed = 0; elapsed < 15_000; elapsed += 1000) {
			pageClock.advance(1000);
			workerClock.advance(1000);
			await settle(2);
		}
		pageClock.advance(500);
		workerClock.advance(500);
		await settle(2);
		assert.equal(delayed.settled(), false, "did not expire at 15.5 s silence boundary");
		assert.deepEqual(postedByPage.map((p) => p.message.type), ["status"], "zero ping messages posted by status probe port across 5 s, 10 s, 15 s");
		pageClock.advance(500);
		workerClock.advance(500);
		await until(delayed.settled, "settled at 16 s when reply arrived");
		assert.equal(delayed.value().state, "running");
		assert.equal(lastClosed, true);

		// Unanswered probe with timeMs: 20_000 settles proxy-unreachable at 20 s, not 15 s:
		returnDelayMs = 0;
		dropReply = true;
		const unanswered = watch(client.status({ timeMs: 20_000 }));
		await settle();
		for (let elapsed = 0; elapsed < 19_000; elapsed += 1000) {
			pageClock.advance(1000);
			workerClock.advance(1000);
			await settle(2);
		}
		pageClock.advance(900);
		workerClock.advance(900);
		await settle(2);
		assert.equal(unanswered.settled(), false, "still waiting at 19.9 s");
		pageClock.advance(100);
		workerClock.advance(100);
		await until(unanswered.settled, "timed out at 20 s deadline");
		assert.deepEqual(unanswered.value(), { state: "unreachable", proxyCode: "proxy-unreachable" });
		assert.equal(lastClosed, true);

		// openPort fallback when openStatusPort is omitted:
		dropReply = false;
		let usedOpenPortFallback = 0;
		const fallbackClient = createBrowserClient(
			{ key: KEY, workerUrl: "https://example.test/worker.js" },
			{
				clock: pageClock,
				identities: machineIdentities,
				openPort: () => { usedOpenPortFallback++; return makePort(); },
			},
		);
		const fallbackStatus = await fallbackClient.status({ timeMs: 1000 });
		assert.equal(fallbackStatus.state, "running");
		assert.equal(usedOpenPortFallback, 1, "openPort fallback used when openStatusPort is omitted");
	} finally {
		proxy.close();
	}
});
