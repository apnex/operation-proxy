// proxy-idle-expiry - a proxy on a machine ends itself after an idle time the application states, and never
// while an invocation it carries is in flight (CONTRACT.md, PX7; zorg's E17).
//
// Needs Unix sockets: the proxy half runs over a real channel socket on an injected clock, the machine proxy
// in this process with an injected clock and a temporary runtime directory - at the idle boundary with a raw
// client as a child process, and with failures injected into its starting and stopping: a failed removal of the
// channel socket, a failed close of the channel's server and of ownership, an observer throwing at each stage,
// a clock reading or timer failing at each point of starting, and a caller that fails to stop, each asserting the status, that every later step ran, that no server is left
// listening, and that a later start in the same process owns the key - and - marked "(processes)" - one
// real proxy process with an idle time of 1 second, and a real client that returns from its program.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { keyDigest } from "@apnex/operation-proxy";
import { startMachineProxyIn } from "../../dist/machine-adapter.js";
import { machineClock } from "../../dist/machine-clock-adapter.js";
import { ensureRuntime, ownershipName } from "../../dist/machine-runtime-adapter.js";
import { createManualHopClock } from "../support/manual-hop-clock.js";
import { rawConnection, settle, until, watch, withCase } from "../support/case-hop.js";
import { alive, fixture, sleep, waitFor } from "../support/processes.js";
import { shortTempDir } from "../support/hop.js";

const CONNECT_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "connect-main.js");
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

const origEmitWarning = process.emitWarning;
process.emitWarning = (w, ...args) => { if (String(w).includes("SQLite")) return; return origEmitWarning.call(process, w, ...args); };
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = origEmitWarning;

/** True while `<runtime directory>/<digest>.lock` is held by some owner, checked synchronously at the moment of the call. */
function held(lockPath) {
	if (!fs.existsSync(lockPath)) return Promise.resolve(false);
	let db;
	try {
		db = new DatabaseSync(lockPath, { timeout: 0 });
		db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS own (x INT); INSERT INTO own VALUES (1);");
		db.close();
		return Promise.resolve(false);
	} catch {
		try { db?.close(); } catch { /* ignore */ }
		return Promise.resolve(true);
	}
}

test("at the idle boundary: a connection the kernel has accepted, not yet taken by the proxy, waiting as the idle timer's first due callback runs, is taken before the proxy checks again, and the same owner stays and serves it", { timeout: 60_000 }, async () => {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `boundary-${process.pid}`, target: "quick" };
	const idleMs = 1000;
	// The machine's clock, but the idle timer's wait is held for the test to run when it chooses, the clock's
	// reading moved past its moment then, so its due callback runs as a real timer callback does.
	let skew = 0n;
	const idleWaits = [];
	const clock = {
		nowNs: () => machineClock.nowNs() + skew,
		schedule(delayMs, callback) {
			if (delayMs !== idleMs) return machineClock.schedule(delayMs, callback);
			const wait = { callback, cancelled: false };
			idleWaits.push(wait);
			return { cancel() { wait.cancelled = true; } };
		},
	};
	const armed = () => idleWaits.filter((w) => !w.cancelled);
	/** Runs the armed idle wait's due callback from a timer callback, as the runtime runs it, after `before`. */
	const due = (before = () => undefined) => new Promise((resolve) => setTimeout(() => {
		const result = before();
		const [wait] = armed();
		wait.cancelled = true;
		skew += BigInt(idleMs) * 1_000_000n;
		wait.callback();
		resolve(result);
	}, 0));
	const log = [];
	const proxy = await startMachineProxyIn(dir, quickApplication(key, idleMs, (w) => log.push(w)), { clock, observe: (stage) => log.push(stage) });
	const name = ownershipName(dir, keyDigest(key));
	const ackDir = shortTempDir();
	let child;
	try {
		await until(() => log.includes("ready") && armed().length === 1, "ready, its idle timer armed");
		const connected = path.join(ackDir, "connected");
		const waiting = await due(() => {
			// Started now, and this thread kept from its event loop - as a loaded proxy's is - until the client
			// reports its connection made: accepted by the kernel, and not yet taken, since only this thread takes it.
			child = spawn(process.execPath, [CONNECT_MAIN, path.join(dir, `${keyDigest(key)}.sock`), ackDir, JSON.stringify(key)], { stdio: "ignore" });
			const end = performance.now() + 20_000;
			while (!fs.existsSync(connected) && performance.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
			return fs.existsSync(connected);
		});
		assert.equal(waiting, true, "the kernel had accepted the connection when the idle timer's due callback ran");
		await waitFor(() => fs.existsSync(path.join(ackDir, "lines.json")), "the client's welcome");
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ackDir, "lines.json"), "utf8")), [{ operationProxy: 1, type: "welcome" }], "welcomed by the same proxy");
		assert.ok(!log.includes("stopping"), "the proxy did not stop");
		assert.equal(await held(name), true, "and still owns its key");
		fs.writeFileSync(path.join(ackDir, "close"), "");
		await waitFor(() => fs.existsSync(path.join(ackDir, "closed")), "the client's connection closed");
		await until(() => armed().length === 1, "the idle timer armed again once the connection closed");
		assert.ok(!log.includes("stopping"));
		// With nothing waiting, the same owner's next due callback ends it.
		await due();
		assert.equal(await proxy.stopped, 0);
		assert.deepEqual(log.slice(-5), ["stopping", "channel-closed", "caller-stop", "caller-stopped", "stopped"]);
		assert.equal(await held(name), false);
	} finally {
		child?.kill("SIGKILL");
		fs.rmSync(ackDir, { recursive: true, force: true });
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
});

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
	name = ownershipName(dir, keyDigest(key));
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

/**
 * Runs a machine proxy in this process with one failure injected into stopping, and checks that stopping is one
 * observed shutdown: no unhandled rejection, the caller still stopped, ownership still released, and `stopped`
 * resolved, with status 1.
 */
let faults = 0;
async function stoppingDespite(what, inject, stop) {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `fault-${process.pid}-${++faults}`, target: "quick" };
	const clock = createManualHopClock();
	const log = [];
	const rejections = [];
	const unhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", unhandled);
	const socketPath = path.join(dir, `${keyDigest(key)}.sock`);
	const restore = inject(socketPath);
	try {
		const proxy = await startMachineProxyIn(dir, quickApplication(key, 1000, (w) => log.push(w)), { clock, observe: (stage) => log.push(stage) });
		const name = ownershipName(dir, keyDigest(key));
		await until(() => log.includes("ready"), "ready");
		let status;
		proxy.stopped.then((s) => { status = s; });
		stop(proxy, clock);
		await until(() => status !== undefined, `stopped to resolve despite ${what}`);
		await settle();
		assert.equal(status, 1, `${what}: the stopped status says a step of stopping failed`);
		assert.deepEqual(rejections, [], `${what}: no unhandled rejection`);
		assert.deepEqual(log.slice(4), ["stopping", "channel-closed", "caller-stop", "caller-stopped", "stopped"], `${what}: every later step still ran`);
		assert.equal(await held(name), false, `${what}: ownership released`);
		restore();
		await ownedAgain(dir, key, what);
	} finally {
		restore();
		await settle();
		process.removeListener("unhandledRejection", unhandled);
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
}

/** Checks that a later start in this process owns the key, serving until it is stopped, and stops it. */
async function ownedAgain(dir, key, what) {
	const stages = [];
	const later = await startMachineProxyIn(dir, quickApplication(key, 1000, () => undefined), { clock: createManualHopClock(), observe: (stage) => stages.push(stage) });
	assert.equal(later.owner, true, `${what}: a later start in the same process owns the key`);
	await until(() => stages.includes("ready"), `${what}: the later start is ready`);
	later.stop();
	assert.equal(await later.stopped, 0, `${what}: the later start stops with status 0`);
}

test("stopping despite a failure to remove the channel socket: the caller still stops, ownership is released, stopped resolves with status 1, and a later start owns the key", async () => {
	let socket;
	let failures = 0;
	await stoppingDespite("an unlink failure", (socketPath) => {
		socket = socketPath;
		const rmSync = fs.rmSync;
		fs.rmSync = (p, ...rest) => {
			if (p === socket) {
				failures++;
				throw Object.assign(new Error("injected unlink failure"), { code: "EACCES" });
			}
			return rmSync(p, ...rest);
		};
		return () => { fs.rmSync = rmSync; };
	}, (proxy) => proxy.stop());
	assert.equal(failures, 1, "the channel socket's removal was tried once, and failed");
});

test("stopping despite a failure to close the channel's server, and to release ownership cleanly: the caller still stops, ownership is released, stopped resolves with status 1, and a later start owns the key", async () => {
	for (const which of ["channel", "ownership"]) {
		await stoppingDespite(`a ${which} close failure`, (socketPath) => {
			if (which === "channel") {
				const close = net.Server.prototype.close;
				net.Server.prototype.close = function (callback) {
					if (this.address() !== socketPath) return close.call(this, callback);
					return close.call(this, () => callback?.(Object.assign(new Error("injected channel close failure"), { code: "EIO" })));
				};
				return () => { net.Server.prototype.close = close; };
			}
			const close = DatabaseSync.prototype.close;
			let thrown = false;
			DatabaseSync.prototype.close = function () {
				close.call(this);
				if (!thrown) {
					thrown = true;
					throw Object.assign(new Error("injected ownership close failure"), { code: "EIO" });
				}
			};
			return () => { DatabaseSync.prototype.close = close; };
		}, (_proxy, clock) => clock.advance(1000));
	}
});

/**
 * Runs a machine proxy in this process whose observer, or caller, fails at one point of its life, and gives
 * what happened: the start's failure or the proxy, the stages observed, what its caller was asked, the servers
 * still listening once it is done, the stopped status, and the rejections left unhandled.
 */
async function failingAt({ stage, callerStop }) {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `failing-${process.pid}-${++faults}`, target: "quick" };
	const stages = [];
	const log = [];
	const rejections = [];
	const unhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", unhandled);
	const servers = [];
	const listen = net.Server.prototype.listen;
	net.Server.prototype.listen = function (...args) { servers.push(this); return listen.apply(this, args); };
	const application = quickApplication(key, 1000, (what) => log.push(what));
	if (callerStop !== undefined) {
		const build = application.buildCaller;
		application.buildCaller = (...args) => ({ ...build(...args), stop: () => { log.push("caller-stop"); return callerStop(); } });
	}
	let proxy;
	let startError;
	let status;
	try {
		try {
			proxy = await startMachineProxyIn(dir, application, { clock: createManualHopClock(), observe: (s) => { stages.push(s); if (s === stage) throw new Error(`observer ${s}`); } });
		} catch (error) {
			startError = error;
		}
		if (proxy !== undefined) {
			proxy.stopped.then((s) => { status = s; });
			await until(() => stages.includes("ready") || status !== undefined, "ready, or stopped");
			proxy.stop();
			await until(() => status !== undefined, "stopped to resolve");
		}
		await settle();
		const name = ownershipName(dir, keyDigest(key));
		const result = { startError, status, stages, log, listening: servers.filter((server) => server.listening).length, owned: await held(name), socket: fs.existsSync(path.join(dir, `${keyDigest(key)}.sock`)), rejections: [...rejections] };
		net.Server.prototype.listen = listen;
		await ownedAgain(dir, key, stage ?? "a caller that fails to stop");
		return result;
	} finally {
		net.Server.prototype.listen = listen;
		for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
		process.removeListener("unhandledRejection", unhandled);
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
}

test("a start that fails after taking ownership - an observer throwing at owned or at listening - closes the channel's server and then ownership before its failure is given, and a later start in the same process owns the key", async () => {
	for (const [stage, seen] of [["owned", ["owned"]], ["listening", ["owned", "listening"]]]) {
		const r = await failingAt({ stage });
		assert.equal(r.startError?.message, `observer ${stage}`, `${stage}: the start fails with the observer's failure`);
		assert.deepEqual(r.stages, seen, `${stage}: nothing started after it`);
		assert.equal(r.listening, 0, `${stage}: no server left listening, the channel's nor ownership's`);
		assert.equal(r.owned, false, `${stage}: ownership released before the failure is given`);
		assert.equal(r.socket, false, `${stage}: no channel socket left`);
		assert.deepEqual(r.rejections, [], `${stage}: no unhandled rejection`);
	}
});

/**
 * A clock port over `clock` that counts its readings and its timers, and fails the `failAt`th of the kind named,
 * `nowNs` or `schedule`, by throwing; `count()` gives how many of each were made.
 */
function faultingClock(clock, { kind, failAt } = {}) {
	const made = { nowNs: 0, schedule: 0 };
	const fault = (which) => {
		made[which]++;
		if (which === kind && made[which] === failAt) throw new Error(`clock ${which} ${failAt} failed`);
	};
	return {
		count: () => ({ ...made }),
		nowNs() { fault("nowNs"); return clock.nowNs(); },
		schedule(delayMs, callback) { fault("schedule"); return clock.schedule(delayMs, callback); },
	};
}

/** How many clock readings and timers a start that succeeds makes before it is given, on a manual clock. */
async function startingClockUse() {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `clock-use-${process.pid}-${++faults}`, target: "quick" };
	const port = faultingClock(createManualHopClock());
	try {
		const proxy = await startMachineProxyIn(dir, quickApplication(key, 1000, () => undefined), { clock: port });
		const made = port.count();
		proxy.stop();
		assert.equal(await proxy.stopped, 0, "the counted start stops with status 0");
		return made;
	} finally {
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
}

/**
 * Starts a machine proxy in this process whose clock port fails at one reading or timer of starting, and checks
 * PX7's failed start: the failure is given only once the idle timer is stopped and the channel's server and
 * ownership are closed; running the clock past the idle time then raises nothing and leaves no timer; and the
 * same process owns the key at once.
 */
async function startFailingOnClock(kind, failAt) {
	const what = `the ${kind} ${failAt} of starting failing`;
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `clock-fault-${process.pid}-${++faults}`, target: "quick" };
	const clock = createManualHopClock();
	const port = faultingClock(clock, { kind, failAt });
	const rejections = [];
	const unhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", unhandled);
	const servers = [];
	const listen = net.Server.prototype.listen;
	net.Server.prototype.listen = function (...args) { servers.push(this); return listen.apply(this, args); };
	try {
		let startError;
		try {
			await startMachineProxyIn(dir, quickApplication(key, 1000, () => undefined), { clock: port });
		} catch (error) {
			startError = error;
		}
		// As the failure is given: nothing of the start is left.
		assert.equal(startError?.message, `clock ${kind} ${failAt} failed`, `${what}: the start fails with the clock's failure`);
		assert.equal(clock.pending(), 0, `${what}: no timer live as the failure is given`);
		assert.equal(servers.filter((server) => server.listening).length, 0, `${what}: no server listening as the failure is given, the channel's nor ownership's`);
		net.Server.prototype.listen = listen;
		assert.equal(await held(ownershipName(dir, keyDigest(key))), false, `${what}: ownership released`);
		assert.equal(fs.existsSync(path.join(dir, `${keyDigest(key)}.sock`)), false, `${what}: no channel socket left`);
		// Past the idle time, several times over: nothing fires, nothing throws.
		assert.doesNotThrow(() => clock.advance(5000), `${what}: running past the idle time raises nothing`);
		assert.equal(clock.pending(), 0, `${what}: no timer live past the idle time`);
		await settle();
		assert.deepEqual(rejections, [], `${what}: no unhandled rejection`);
		await ownedAgain(dir, key, what);
	} finally {
		net.Server.prototype.listen = listen;
		for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
		process.removeListener("unhandledRejection", unhandled);
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
}

test("a start whose clock reading throws - at each reading starting makes, the call clock's origin included - stops its idle timer and closes the channel's server and ownership before its failure is given; past the idle time nothing throws and no timer or server is live, and the same process owns the key at once", { timeout: 60_000 }, async () => {
	const made = await startingClockUse();
	// The idle timer's moment, its first delay, and the call clock's origin, at the least.
	assert.ok(made.nowNs >= 3, `a start reads the clock at least three times, not ${made.nowNs}`);
	for (let failAt = 1; failAt <= made.nowNs; failAt++) await startFailingOnClock("nowNs", failAt);
});

test("a start whose clock cannot arm a timer - at each timer starting arms - closes everything it opened before its failure is given; past the idle time nothing throws, and the same process owns the key at once", { timeout: 60_000 }, async () => {
	const made = await startingClockUse();
	assert.ok(made.schedule >= 1, `a start arms its idle timer, not ${made.schedule} timers`);
	for (let failAt = 1; failAt <= made.schedule; failAt++) await startFailingOnClock("schedule", failAt);
});

test("on the system's own clock, a start whose call clock's origin reading throws leaves no idle timer to fire: past the idle time nothing throws, and the same process owns the key at once", { timeout: 60_000 }, async () => {
	const dir = path.join(shortTempDir(), "rt");
	const key = { application: "fixture", identity: `clock-origin-${process.pid}-${++faults}`, target: "quick" };
	const uncaught = [];
	const monitor = (error) => uncaught.push(error);
	process.on("uncaughtExceptionMonitor", monitor);
	// The origin is the reading after the observer is told `listening`.
	let originNext = false;
	const port = {
		nowNs() {
			if (originNext) {
				originNext = false;
				throw new Error("call clock origin unavailable");
			}
			return machineClock.nowNs();
		},
		schedule: (delayMs, callback) => machineClock.schedule(delayMs, callback),
	};
	const servers = [];
	const listen = net.Server.prototype.listen;
	net.Server.prototype.listen = function (...args) { servers.push(this); return listen.apply(this, args); };
	try {
		await assert.rejects(startMachineProxyIn(dir, quickApplication(key, 1000, () => undefined), { clock: port, observe: (stage) => { if (stage === "listening") originNext = true; } }), /call clock origin unavailable/);
		assert.equal(servers.filter((server) => server.listening).length, 0, "no server listening as the failure is given");
		net.Server.prototype.listen = listen;
		assert.equal(await held(ownershipName(dir, keyDigest(key))), false, "ownership released at once");
		// The idle time is 1 second; three are waited, for a loaded machine.
		await sleep(3000);
		assert.deepEqual(uncaught.map(String), [], "nothing thrown past the idle time");
		await ownedAgain(dir, key, "the call clock's origin failing on the system's clock");
	} finally {
		net.Server.prototype.listen = listen;
		for (const server of servers) if (server.listening) await new Promise((resolve) => server.close(resolve));
		process.removeListener("uncaughtExceptionMonitor", monitor);
		fs.rmSync(path.dirname(dir), { recursive: true, force: true });
	}
});

test("an observer throwing at each later stage of starting and of stopping makes the status 1; every later step still runs, no server is left listening, and a later start owns the key", async () => {
	for (const stage of ["built", "ready", "stopping", "channel-closed", "caller-stopped", "stopped"]) {
		const r = await failingAt({ stage });
		assert.equal(r.startError, undefined, `${stage}: the start itself succeeds`);
		assert.equal(r.status, 1, `${stage}: the status says a step failed`);
		assert.deepEqual(r.stages.slice(r.stages.indexOf("stopping")), ["stopping", "channel-closed", "caller-stopped", "stopped"], `${stage}: every later step still ran`);
		assert.deepEqual(r.log, ["caller-stop"], `${stage}: the caller was stopped`);
		assert.equal(r.listening, 0, `${stage}: no server left listening`);
		assert.equal(r.owned, false, `${stage}: ownership released`);
		assert.equal(r.socket, false, `${stage}: the channel socket removed`);
		assert.deepEqual(r.rejections, [], `${stage}: no unhandled rejection`);
	}
});

test("a caller that fails to stop, throwing or rejecting, leaves the status as it was, 0; every later step still runs, and a later start owns the key", async () => {
	for (const [what, callerStop] of [["throwing", () => { throw new Error("stop failed"); }], ["rejecting", () => Promise.reject(new Error("stop failed"))]]) {
		const r = await failingAt({ callerStop });
		assert.equal(r.status, 0, `${what}: the status as it was`);
		assert.deepEqual(r.stages.slice(r.stages.indexOf("stopping")), ["stopping", "channel-closed", "caller-stopped", "stopped"], `${what}: every later step still ran`);
		assert.deepEqual(r.log, ["caller-stop"], `${what}: the caller was asked to stop`);
		assert.equal(r.listening, 0, `${what}: no server left listening`);
		assert.equal(r.owned, false, `${what}: ownership released`);
		assert.deepEqual(r.rejections, [], `${what}: no unhandled rejection`);
	}
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

test("(processes) a client that returns from its program after its ending, closing nothing and never calling process.exit, ends by itself; its proxy then idles out", { timeout: 60_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	const c = f.client({ operation: "which", idleMs: 1000, connectMs: 20_000, natural: true });
	const ack = await c.ack();
	assert.equal(ack.ending.ending, "answered");
	const pid = ack.ending.answer.pid;
	const exit = await Promise.race([c.exited, sleep(10_000).then(() => "still running")]);
	assert.deepEqual(exit, { code: 0, signal: null }, "the client ended by itself once its ending was read");
	assert.ok(alive(pid) || f.reached(pid, "stopping"), "the proxy was not killed with its client");
	await waitFor(() => !alive(pid), "the proxy to idle out", 20_000);
	assert.equal(f.exits().get(pid), 0);
	assert.deepEqual(f.stages().filter((s) => s.pid === pid).map((s) => s.stage).slice(-5), ["stopping", "channel-closed", "caller-stopped", "stopped", "exit"]);
	assert.ok(!fs.existsSync(f.socketPath()), "the channel socket removed");
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
