// proxy-idle-expiry - a proxy on a machine ends itself after an idle time the application states, and never
// while an invocation it carries is in flight (CONTRACT.md, PX7; zorg's E17).
//
// Needs Unix sockets: the proxy half runs over a real channel socket on an injected clock, the machine proxy
// in this process with an injected clock and a temporary runtime directory, and - marked "(processes)" - one
// real proxy process with an idle time of 1 second.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { keyDigest } from "@apnex/operation-proxy";
import { startMachineProxyIn } from "../../dist/machine-adapter.js";
import { ensureRuntime, ownershipName } from "../../dist/machine-runtime-adapter.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";
import { rawConnection, settle, until, watch, withCase } from "../support/case-hop.js";
import { alive, fixture, sleep, waitFor } from "../support/processes.js";
import { shortTempDir } from "../support/hop.js";

const fixtures = [];
after(async () => { for (const f of fixtures) await f.cleanup(); });

/** A case whose proxy half has an idle time of 1 second on a manual clock, counting each time it ends idle. */
async function idleCase(body, clockOptions) {
	let idled = 0;
	await withCase({ idleMs: 1000, onIdle: () => { idled++; }, clock: clockOptions ? createManualHopClock(clockOptions) : undefined }, (c) => body(c, () => idled));
}

test("a proxy with no connection open and no call in flight ends after its idle time, not before", async () => {
	await idleCase(async (c, idled) => {
		c.clock.advance(999);
		assert.equal(idled(), 0);
		c.clock.advance(1);
		assert.equal(idled(), 1);
		c.clock.advance(5000);
		assert.equal(idled(), 1, "it ends once");
	});
});

test("a timer waking early is not the idle time passing: the clock is read and the timer set again", async () => {
	await idleCase(async (c, idled) => {
		c.clock.advance(700);
		assert.equal(idled(), 0, "the timer woke 300 ms early and found time remaining");
		c.clock.advance(299);
		assert.equal(idled(), 0);
		c.clock.advance(1);
		assert.equal(idled(), 1);
	}, { earlyMs: 300 });
});

test("an open connection keeps the proxy; once it closes, the idle time runs again from then", async () => {
	await idleCase(async (c, idled) => {
		c.clock.advance(500);
		assert.equal(await c.client.prepare({ timeMs: 1000 }), "ready");
		c.clock.advance(5000);
		assert.equal(idled(), 0, "a connection is open");
		c.client.close();
		await until(() => c.hop.half.connections() === 0, "the connection closed");
		c.clock.advance(999);
		assert.equal(idled(), 0, "idle for less than its idle time since the connection closed");
		c.clock.advance(1);
		assert.equal(idled(), 1);
	});
});

test("a call in flight keeps the proxy past its idle time though its process has gone; once the call ends the idle time runs", async () => {
	await idleCase(async (c, idled) => {
		const call = watch(c.call({ operation: "hold", bound: 100_000 }));
		await until(() => c.a.holds.length === 1, "the call in flight");
		c.client.close();
		await until(() => c.hop.half.connections() === 0, "the process's connection gone");
		await until(call.settled, "the process's own ending");
		assert.equal(call.value().reason, "proxy-lost");
		assert.equal(c.hop.half.inFlight(), 1, "the call is still in flight");
		c.clock.advance(5000);
		assert.equal(idled(), 0, "never ends while a call is in flight");
		c.a.holds[0].release();
		await until(() => c.hop.half.inFlight() === 0, "the call finished, its ending dropped");
		c.clock.advance(999);
		assert.equal(idled(), 0);
		c.clock.advance(1);
		assert.equal(idled(), 1);
		assert.equal(c.calls.length, 1, "the call was made once");
	});
});

test("a client connecting as the idle timer falls due keeps the proxy: on firing it checks again and stays", async () => {
	await idleCase(async (c, idled) => {
		c.clock.move(1000);
		const raw = await rawConnection(c.hop.socketPath);
		await until(() => c.hop.half.connections() === 1, "the connection accepted");
		c.clock.advance(0);
		c.clock.advance(5000);
		assert.equal(idled(), 0, "the proxy stays while the connection is open");
		raw.end();
		await until(() => c.hop.half.connections() === 0, "the connection closed");
		c.clock.advance(1000);
		assert.equal(idled(), 1);
	});
});

/** A minimal application whose caller answers every call at once, for the machine proxy in this process. */
function quickApplication(key, idleMs, log) {
	return {
		key, idleMs,
		buildCaller: () => ({ caller: { invoke: async (call) => ({ ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000000`, operation: call.operation, answer: null }) }, stop: () => log("caller-stop") }),
		callerReady: () => undefined,
	};
}

/** True while an abstract-namespace name is held by some process. */
function held(name) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(true));
		server.listen({ path: name, exclusive: true }, () => server.close(() => resolve(false)));
	});
}

test("stopping when idle: it stops accepting, closes connections not welcomed, removes the channel socket, stops its caller, and releases ownership last", async () => {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `idle-${process.pid}`, target: "quick" };
	const clock = createManualHopClock();
	const log = [];
	const socketPath = path.join(dir, `${keyDigest(key)}.sock`);
	let name;
	let checks;
	const application = quickApplication(key, 1000, (what) => {
		log.push(what);
		checks = Promise.all([held(name), Promise.resolve(fs.existsSync(socketPath))]);
	});
	const proxy = await startMachineProxyIn(dir, application, { clock, observe: (stage) => log.push(stage) });
	name = ownershipName(ensureRuntime(dir), keyDigest(key));
	assert.equal(proxy.owner, true);
	await until(() => log.includes("ready"), "ready");
	const unwelcomed = await rawConnection(socketPath);
	await settle();
	unwelcomed.end();
	await settle();
	clock.advance(1000);
	assert.equal(await proxy.stopped, 0, "it exits with status 0");
	assert.deepEqual(log, ["owned", "listening", "built", "ready", "stopping", "channel-closed", "caller-stop", "caller-stopped", "stopped"]);
	const [ownedWhileCallerStopped, socketWhileCallerStopped] = await checks;
	assert.equal(ownedWhileCallerStopped, true, "ownership still held while its caller stops");
	assert.equal(socketWhileCallerStopped, false, "the channel socket already removed when its caller stops");
	assert.equal(await held(name), false, "ownership released last");
	assert.ok(!fs.existsSync(socketPath));
	fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test("stopping on request, as on SIGTERM, waits for each call in flight to end and its ending to be sent; connections not welcomed are closed", async () => {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `term-${process.pid}`, target: "held" };
	const clock = createManualHopClock();
	const release = Promise.withResolvers();
	let readyNow = Promise.withResolvers();
	const application = {
		key, idleMs: 60_000,
		buildCaller: () => ({ caller: { invoke: async (call) => { await release.promise; return { ending: "answered", invocation: call.invocation, attempt: `${call.invocation}.00000000`, operation: call.operation, answer: "late" }; } }, stop: () => undefined }),
		callerReady: () => readyNow.promise,
	};
	const stages = [];
	const proxy = await startMachineProxyIn(dir, application, { clock, observe: (s) => stages.push(s) });
	const socketPath = path.join(dir, `${keyDigest(key)}.sock`);
	const waiting = await rawConnection(socketPath);
	waiting.send({ operationProxy: 1, type: "hello", key });
	readyNow.resolve();
	await until(() => waiting.lines.length === 1, "welcome");
	waiting.send({ operationProxy: 1, type: "invoke", request: 1, invocation: "1791540000000-0123456789abcdef", host: "h", service: "s", operation: "o", input: null, deadline: String(clock.nowNs() + 60_000_000_000n), repeat: false, aborted: false });
	await settle();
	const unwelcomed = await rawConnection(socketPath);
	await settle();
	proxy.stop();
	await settle(60);
	assert.ok(!stages.includes("stopping"), "it waits for the call in flight");
	assert.ok(!unwelcomed.closed());
	release.resolve();
	assert.equal(await proxy.stopped, 0);
	assert.deepEqual(waiting.lines.map((l) => l.type), ["welcome", "end"], "the ending was sent before it stopped");
	assert.equal(waiting.lines[1].ending.answer, "late");
	await until(() => unwelcomed.closed() && waiting.closed(), "every connection closed");
	assert.deepEqual(stages.slice(-4), ["stopping", "channel-closed", "caller-stopped", "stopped"]);
	fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	readyNow = undefined;
});

test("(processes) one real proxy with an idle time of 1 second ends about 1 second after its last client, exits 0 and removes its channel socket", { timeout: 60_000 }, async () => {
	const f = fixture({ idleMs: 60_000 });
	fixtures.push(f);
	const ack = await f.client({ operation: "which", idleMs: 1000, connectMs: 20_000 }).ack();
	const pid = ack.ending.answer.pid;
	const left = performance.now();
	assert.equal(f.stages().find((s) => s.pid === pid && s.stage === "started").idleMs, 1000, "the launching command's idle time prevails");
	await waitFor(() => !alive(pid), "the proxy to end", 20_000);
	const ms = performance.now() - left;
	assert.ok(ms >= 900, `not before its idle time: ${Math.round(ms)} ms`);
	assert.equal(f.exits().get(pid), 0);
	assert.ok(!fs.existsSync(f.socketPath()), "the channel socket removed");
	assert.deepEqual(f.stages().filter((s) => s.pid === pid).map((s) => s.stage).slice(-5), ["stopping", "channel-closed", "caller-stopped", "stopped", "exit"]);
});

test("(processes) a call in flight past the idle time, its client gone, keeps the real proxy running until the call ends", { timeout: 60_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	const c = f.client({ operation: "hold", bound: 30_000, idleMs: 1000, connectMs: 20_000 });
	await waitFor(() => f.runs().some((r) => r.operation === "hold"), "the call in flight");
	const pid = f.owners()[0];
	c.child.kill("SIGKILL");
	await c.exited;
	await sleep(2500);
	assert.ok(alive(pid), "still running 2.5 s after its last client went, its call in flight");
	assert.ok(!f.reached(pid, "stopping"), "and not stopping");
	fs.writeFileSync(path.join(f.records, "release"), "");
	await waitFor(() => !alive(pid), "the proxy to end once the call has ended", 20_000);
	assert.equal(f.exits().get(pid), 0);
});

test("(processes) clients connecting as the real proxy's idle timer fires are each served, by it or by the next proxy", { timeout: 120_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	for (const offset of [900, 980, 1000, 1020, 1100]) {
		const first = await f.client({ operation: "which", idleMs: 1000, connectMs: 20_000 }).ack();
		assert.equal(first.ending.ending, "answered");
		await sleep(offset);
		const second = await f.client({ operation: "which", idleMs: 1000, connectMs: 20_000 }).ack();
		assert.equal(second.ending.ending, "answered", `a client ${offset} ms after the last: ${JSON.stringify(second.ending)}`);
		await waitFor(() => !alive(second.ending.answer.pid), "the proxy to end", 20_000);
	}
	for (const [pid, status] of f.exits()) assert.equal(status, 0, `proxy ${pid} exits 0`);
});


for (const signal of ["SIGTERM", "SIGINT"]) {
	test(`(processes) on ${signal} a real proxy stops once its call in flight has ended and its ending has been sent, and exits 0`, { timeout: 60_000 }, async () => {
		const f = fixture();
		fixtures.push(f);
		const c = f.client({ operation: "hold", bound: 30_000, connectMs: 20_000 });
		await waitFor(() => f.runs().some((r) => r.operation === "hold"), "the call in flight");
		const pid = f.owners()[0];
		process.kill(pid, signal);
		await sleep(1000);
		assert.ok(alive(pid), "it waits for its call in flight");
		assert.ok(!f.reached(pid, "stopping"));
		fs.writeFileSync(path.join(f.records, "release"), "");
		const ack = await c.ack();
		assert.equal(ack.ending.ending, "answered", "the ending was sent before it stopped");
		await waitFor(() => !alive(pid), "the proxy to exit");
		assert.equal(f.exits().get(pid), 0);
		assert.ok(!fs.existsSync(f.socketPath()));
		assert.deepEqual(f.stages().filter((s) => s.pid === pid).map((s) => s.stage).slice(-5), ["stopping", "channel-closed", "caller-stopped", "stopped", "exit"]);
	});
}
