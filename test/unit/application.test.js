// application - what an application supplies (CONTRACT.md, PX9), each setting checked as the client half and the
// proxy are built. Needs no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createProxyHalf } from "@apnex/operation-proxy";
import { createMachineClient, startMachineProxy } from "@apnex/operation-proxy/machine";
import { createManualHopClock } from "../support/manual-hop-clock.js";

const clock = createManualHopClock();

test("PX9: what an application supplies - its hop allowance, from 0 to 1000 ms; its idle time, from 1 second to 24 hours; its launching command - is checked", async () => {
	const key = { application: "zorg", identity: "alice", target: "t" };
	const launch = { command: process.execPath, args: ["proxy.js", "--idle", "10m"] };
	for (const hopAllowanceMs of [0, 1, 50, 1000, undefined]) assert.doesNotThrow(() => createMachineClient({ key, launch, hopAllowanceMs }));
	for (const hopAllowanceMs of [-1, 1001, 1.5, "50", null, Number.NaN]) assert.throws(() => createMachineClient({ key, launch, hopAllowanceMs }), RangeError, String(hopAllowanceMs));
	for (const bad of [undefined, {}, { command: "" }, { command: 7 }, { command: "x", args: [1] }, { command: "x", args: "y" }]) assert.throws(() => createMachineClient({ key, launch: bad }), TypeError);
	for (const idleMs of [1000, 86_400_000]) assert.doesNotThrow(() => createProxyHalf({ key, clock, idleMs, onIdle: () => undefined }).stopIdle());
	for (const idleMs of [999, 86_400_001, 1500.5, "1000", undefined]) {
		assert.throws(() => createProxyHalf({ key, clock, idleMs, onIdle: () => undefined }), RangeError, String(idleMs));
		await assert.rejects(startMachineProxy({ key, idleMs, buildCaller: () => undefined, callerReady: () => undefined }), RangeError);
	}
	await assert.rejects(startMachineProxy({ key, idleMs: 1000 }), TypeError, "a proxy needs buildCaller and callerReady");
});

