// client-preparing - the client half's preparing on an injected clock (CONTRACT.md, PX3, PX5): connecting again
// every 100 ms and launching at most every 500 ms while nothing answers. Needs no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxyClient } from "@apnex/operation-proxy";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";
import { sleep } from "../support/processes.js";

test("while nothing answers, the client half connects again every 100 ms and launches at most every 500 ms, until the connect deadline", async () => {
	const clock = createManualHopClock();
	const connects = [];
	const launches = [];
	const connector = {
		connect: async () => { connects.push(clock.elapsedMs()); return { kind: "absent" }; },
		launch: () => { launches.push(clock.elapsedMs()); },
	};
	const client = createProxyClient({ key: { application: "a", identity: "b", target: "c" }, connector, clock, identities: machineIdentities });
	const preparing = client.prepare({ timeMs: 1550 });
	for (let t = 0; t < 1600; t += 10) {
		await sleep(0);
		await new Promise((resolve) => setImmediate(resolve));
		clock.advance(10);
	}
	const result = await preparing;
	assert.equal(result.proxyCode, "proxy-unreachable");
	assert.deepEqual(connects, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500]);
	assert.deepEqual(launches, [0, 500, 1000, 1500]);
});
