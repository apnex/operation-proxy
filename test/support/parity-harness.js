// parity-harness - operation-call's caller suite harness for the client half (CONTRACT.md, PX10): each case a
// fresh session of the client half and the proxy half in one process over a real channel socket, the proxy's
// caller operation-call's own over AGP's production in-process carrier, the hop intact. The client half, the
// proxy half and the call layer run on one controllable monotonic timeline, the call bound's clock, apart from
// AGP's injected clock; a case asking for the real clock runs all three on CLOCK_MONOTONIC. The harness states
// the hop allowance the client half keeps, so the suite judges every case by PX5's rule. Needs Unix sockets.
//
// The suite's clock-port fault reaches the client half's own clock port alone, never the proxy half's or the
// call layer's beneath the hop (zorg's EM12; PX10): the client half reads the timeline through a port that,
// armed, throws once at its next reading or its next timer's cancellation, leaving that timer to run, and
// records each throw. What the client half keeps is observed at its edges: the timers on that port, the
// connections it holds its process open by, and the connections it is still making. Its next preparing is
// refused by the proxy itself - `key-mismatch` - when its `hello` names another identity than the proxy's.
// The suite's fixture hosts keep time on a clock port over the same timeline, which the harness gives as
// `callClock` (zorg's EM12; Delta 4, stage 6).
import { callClockOf } from "@apnex/operation-proxy";
import { machineClock } from "../../dist/machine-clock-adapter.js";
import { openHop } from "./hop.js";
import { createManualHopClock } from "./manual-hop-clock.js";
import { openTopology } from "./topology.js";

/** The client half's clock port over the hop's clock, with the suite's fault hook. */
export function faultableHopClock(clock) {
	let armed;
	const faults = [];
	const live = new Set();
	return {
		faults,
		arm(at) {
			if (at !== "read" && at !== "cancel") throw new RangeError(`a clock port fails at a reading or a cancellation, not ${at}`);
			armed = at;
		},
		outstanding: () => live.size,
		nowNs() {
			if (armed === "read") {
				armed = undefined;
				faults.push("read");
				throw new Error("the caller suite's fault hook: the client half's clock port could not be read");
			}
			return clock.nowNs();
		},
		schedule(delayMs, callback) {
			const entry = {};
			live.add(entry);
			let timer;
			try {
				timer = clock.schedule(delayMs, () => { live.delete(entry); callback(); });
			} catch (error) {
				live.delete(entry);
				throw error;
			}
			return {
				cancel() {
					if (armed === "cancel") {
						armed = undefined;
						faults.push("cancel");
						throw new Error("the caller suite's fault hook: the client half's clock port could not cancel a timer");
					}
					live.delete(entry);
					timer.cancel();
				},
			};
		},
	};
}

/**
 * The client half's connector, observed: each link it holds its process open by, each connection it is still
 * making, and, once armed, a `hello` naming another identity, which the proxy refuses as `key-mismatch`.
 */
function observedConnector(base) {
	const held = new Set();
	let connecting = 0;
	let refuseNext = false;
	return {
		held: () => held.size,
		connecting: () => connecting,
		refuseNext() {
			refuseNext = true;
		},
		connector: {
			async connect(handlers) {
				connecting++;
				let link;
				let outcome;
				try {
					outcome = await base.connect({ message: (value) => handlers.message(value), closed: () => { held.delete(link); handlers.closed(); } });
				} finally {
					connecting--;
				}
				if (outcome.kind !== "connected") return outcome;
				const refusing = refuseNext;
				refuseNext = false;
				const inner = outcome.link;
				link = {
					write: (message) => inner.write(refusing && message.type === "hello" ? { ...message, key: { ...message.key, identity: `${message.key.identity}-refused` } } : message),
					close: () => { held.delete(link); inner.close(); },
					hold(keep) {
						if (keep) held.add(link);
						else held.delete(link);
						inner.hold(keep);
					},
				};
				return { kind: "connected", link };
			},
			launch: () => base.launch(),
		},
	};
}

export function parityHarness({ allowanceMs = 50 } = {}) {
	return {
		hopAllowanceMs: allowanceMs,
		async open(options = {}) {
			const clock = options.realCallClock ? machineClock : createManualHopClock();
			const clientClock = faultableHopClock(clock);
			const unhandled = [];
			const onUnhandled = (error) => { unhandled.push(error); };
			process.on("unhandledRejection", onUnhandled);
			process.on("uncaughtException", onUnhandled);
			let observed;
			let hop;
			let t;
			try {
				t = await openTopology({ holdDeliveryReports: options.holdDeliveryReports });
				hop = await openHop({ clock, clientClock, allowanceMs, topology: t, connect: (base) => (observed = observedConnector(base)).connector });
				await hop.ready;
			} catch (error) {
				process.off("unhandledRejection", onUnhandled);
				process.off("uncaughtException", onUnhandled);
				await hop?.close();
				await t?.close();
				throw error;
			}
			const manual = (what) => {
				if (options.realCallClock) throw new Error(`${what}: this session runs on CLOCK_MONOTONIC, which no hook moves`);
				return clock;
			};
			// The suite's fixture hosts keep time on the call bound's timeline, the clock the proxy's call and the
			// client half read (zorg's EM12; PX10).
			const hostClock = callClockOf(clock);
			const hooks = {
				...t.hooks,
				callClock: () => hostClock,
				advanceCallClock: (ms) => manual("advanceCallClock").advance(ms),
				moveCallClock: (ms) => manual("moveCallClock").move(ms),
				failCallClock: (at) => clientClock.arm(at),
				callClockFaults: () => [...clientClock.faults],
				outstanding: () => clientClock.outstanding() + observed.held() + observed.connecting(),
				unhandled: () => [...unhandled],
				refuseNextPreparing() {
					observed.refuseNext();
					return "key-mismatch";
				},
			};
			return {
				caller: hop.client, callerNodeId: t.callerNodeId, hosts: t.hosts, hooks, hop,
				async close() {
					try {
						await hop.close();
						await t.close();
					} finally {
						process.off("unhandledRejection", onUnhandled);
						process.off("uncaughtException", onUnhandled);
					}
				},
			};
		},
	};
}
