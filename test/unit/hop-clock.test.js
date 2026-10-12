// hop-clock - the call layer's clock port over the hop's clock (CONTRACT.md, PX5). Needs no socket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { callClockOf } from "@apnex/operation-proxy";
import { createManualHopClock } from "../support/manual-hop-clock.js";

test("callClockOf gives the call layer milliseconds on the hop clock, and pins one reading for the call the proxy makes", () => {
	const clock = createManualHopClock();
	const callClock = callClockOf(clock);
	clock.advance(12.5);
	assert.equal(callClock.now(), 12.5);
	const reading = clock.nowNs();
	clock.move(3);
	callClock.pin(reading);
	assert.equal(callClock.now(), 12.5, "the pinned reading, once");
	assert.equal(callClock.now(), 15.5);
});
