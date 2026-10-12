// parity-harness - operation-call's caller suite harness for the client half (CONTRACT.md, PX10): each case a
// fresh session of the client half and the proxy half in one process over a real channel socket, the proxy's
// caller operation-call's own over AGP's production in-process carrier, the hop intact. The client half, the
// proxy half and the call layer run on one controllable monotonic timeline, the call bound's clock, apart from
// AGP's injected clock; a case asking for the real clock runs all three on CLOCK_MONOTONIC. The harness states
// the hop allowance the client half keeps, so the suite judges every case by PX5's rule. Needs Unix sockets.
import { machineClock } from "../../dist/machine-clock-adapter.js";
import { openHop } from "./hop.js";
import { createManualHopClock } from "./manual-hop-clock.js";
import { openTopology } from "./topology.js";

export function parityHarness({ allowanceMs = 50 } = {}) {
	return {
		hopAllowanceMs: allowanceMs,
		async open(options = {}) {
			const clock = options.realCallClock ? machineClock : createManualHopClock();
			const t = await openTopology({ holdDeliveryReports: options.holdDeliveryReports });
			const hop = await openHop({ clock, allowanceMs, topology: t });
			await hop.ready;
			const manual = (what) => {
				if (options.realCallClock) throw new Error(`${what}: this session runs on CLOCK_MONOTONIC, which no hook moves`);
				return clock;
			};
			const hooks = {
				...t.hooks,
				advanceCallClock: (ms) => manual("advanceCallClock").advance(ms),
				moveCallClock: (ms) => manual("moveCallClock").move(ms),
			};
			return {
				caller: hop.client, callerNodeId: t.callerNodeId, hosts: t.hosts, hooks, hop,
				async close() {
					await hop.close();
					await t.close();
				},
			};
		},
	};
}
