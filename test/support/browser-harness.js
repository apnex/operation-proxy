// browser-harness - operation-call's caller suite harness for the browser adapter's client half (CONTRACT.md,
// PX8, PX10; zorg's Delta 4, stage 6, D4-E6): each case a fresh session of a page's client half and a shared
// worker's proxy in one process, joined by a real MessageChannel, the worker's caller operation-call's own over
// AGP's production in-process carrier. The page and the worker read one controllable timeline, the call bound's
// clock, apart from AGP's injected clock; the suite's fixture hosts keep time on a clock port over the same
// timeline, which the harness gives as `callClock`. It states the hop allowance the page keeps, so the suite
// judges every case by PX5's rule. The suite's clock-port fault reaches the page's own clock port alone.
//
// Each side's `ping` timers run on the timeline too, so a case that ran it past 5 seconds would see them; none of
// the rows this harness serves does.
import { createCaller } from "@apnex/operation-call";
import { callClockOf } from "@apnex/operation-proxy";
import { createBrowserClient, runBrowserProxy } from "@apnex/operation-proxy/browser";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { KEY } from "./hop.js";
import { createManualHopClock } from "./manual-hop-clock.js";
import { faultableHopClock } from "./parity-harness.js";
import { openTopology } from "./topology.js";

export function browserHarness({ allowanceMs = 50 } = {}) {
	return {
		hopAllowanceMs: allowanceMs,
		async open(options = {}) {
			if (options.realCallClock) throw new Error("the browser harness runs on a controlled timeline only; no row it serves asks for the real clock");
			const clock = createManualHopClock();
			const pageClock = faultableHopClock(clock);
			const unhandled = [];
			const onUnhandled = (error) => { unhandled.push(error); };
			process.on("unhandledRejection", onUnhandled);
			process.on("uncaughtException", onUnhandled);
			const t = await openTopology({ holdDeliveryReports: options.holdDeliveryReports });
			const ports = [];
			let built;
			const proxy = runBrowserProxy({
				key: KEY,
				async buildCaller(_key, { clock: callClock }) {
					built = await createCaller({ node: t.sendingNode, clock: callClock });
					return { caller: built, stop: () => built.close() };
				},
				callerReady: () => undefined,
			}, { clock, scope: {} });
			await proxy.ready;
			const client = createBrowserClient({ key: KEY, workerUrl: "https://example.test/worker.js", hopAllowanceMs: allowanceMs }, {
				clock: pageClock,
				identities: machineIdentities,
				openPort() {
					const channel = new MessageChannel();
					ports.push(channel.port1, channel.port2);
					proxy.connectPort(channel.port2);
					return channel.port1;
				},
			});
			const hostClock = callClockOf(clock);
			const hooks = {
				...t.hooks,
				callClock: () => hostClock,
				advanceCallClock: (ms) => clock.advance(ms),
				moveCallClock: (ms) => clock.move(ms),
				failCallClock: (at) => pageClock.arm(at),
				callClockFaults: () => [...pageClock.faults],
				outstanding: () => pageClock.outstanding(),
				unhandled: () => [...unhandled],
			};
			return {
				caller: client, callerNodeId: t.callerNodeId, hosts: t.hosts, hooks,
				async close() {
					try {
						client.close();
						proxy.close();
						for (const port of ports) port.close();
						await built?.close();
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
