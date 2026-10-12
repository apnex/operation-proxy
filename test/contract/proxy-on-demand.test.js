// proxy-on-demand - a proxy is there when the first process of an application, identity and target needs it,
// with nothing set up beforehand: processes that start at once end with one proxy, and a proxy left behind by
// a crash is replaced (CONTRACT.md, PX3; zorg's E17).
//
// Needs Unix sockets, abstract-namespace sockets and child processes: the fixture application's short-lived
// clients and its proxies are real processes, each with a runtime directory of its own. The launch cadence,
// which needs no socket, is checked on an injected clock in test/unit/client-preparing.test.js.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";
import { alive, fixture, waitFor } from "../support/processes.js";

const fixtures = [];
const make = (options) => {
	const f = fixture(options);
	fixtures.push(f);
	return f;
};
after(async () => { for (const f of fixtures) await f.cleanup(); });

/** zorg's default connect timeout (RT2), within which a crashed proxy is replaced. */
const CONNECT_MS = 5000;

test("20 processes started at once leave one owner, every invocation carried by it, and every losing starter exits 0 touching nothing", { timeout: 120_000 }, async () => {
	const f = make();
	const clients = Array.from({ length: 20 }, () => f.client({ operation: "which", connectMs: 30_000, bound: 30_000 }));
	const acks = await Promise.all(clients.map((c) => c.ack(90_000)));
	for (const ack of acks) assert.equal(ack.ending.ending, "answered", JSON.stringify(ack.ending));
	const owners = f.owners();
	assert.equal(owners.length, 1, `one owner, not ${owners.length}`);
	assert.deepEqual([...new Set(acks.map((a) => a.ending.answer.pid))], owners, "every invocation was carried by the one owner");
	await waitFor(() => f.started().every((pid) => pid === owners[0] || f.exits().has(pid)), "every losing starter to exit");
	for (const pid of f.started()) {
		if (pid === owners[0]) continue;
		assert.equal(f.exits().get(pid), 0, `starter ${pid} exits with status 0`);
		assert.ok(!f.reached(pid, "listening"), `starter ${pid} never touched the channel socket`);
	}
});

test("20 proxies started at once beside a running owner each exit 0, and the owner's channel socket is the same file, still served", { timeout: 120_000 }, async () => {
	const f = make();
	const first = await f.client({ operation: "which" }).ack();
	assert.equal(first.ending.ending, "answered");
	const owner = first.ending.answer.pid;
	const before = fs.statSync(f.socketPath());
	const starters = Array.from({ length: 20 }, () => f.proxy());
	const exits = await Promise.all(starters.map((s) => s.exited));
	for (const exit of exits) assert.deepEqual(exit, { code: 0, signal: null }, "a starter that loses exits with status 0");
	const afterwards = fs.statSync(f.socketPath());
	assert.equal(afterwards.ino, before.ino, "a starter that loses never removes or replaces the channel socket");
	assert.equal(afterwards.birthtimeMs, before.birthtimeMs);
	const again = await f.client({ operation: "which" }).ack();
	assert.equal(again.ending.answer.pid, owner, "the same owner still serves");
	assert.deepEqual(f.owners(), [owner]);
});

for (const [stage, what] of [["owned", "just after taking ownership"], ["listening", "just after listening on the channel"], ["ready", "while serving"]]) {
	test(`a proxy killed with SIGKILL ${what} is replaced by the next command within zorg's default connect timeout of 5 seconds`, { timeout: 120_000 }, async () => {
		const f = make({ blockAt: stage === "ready" ? undefined : stage, blockMs: 60_000 });
		let victim;
		if (stage === "ready") {
			const served = await f.client({ operation: "which" }).ack();
			assert.equal(served.ending.ending, "answered");
			victim = served.ending.answer.pid;
		} else {
			f.client({ operation: "which", connectMs: 2000 });
			victim = (await waitFor(() => f.stages().find((s) => s.stage === `blocked-at-${stage}`), `a proxy blocked at ${stage}`)).pid;
		}
		process.kill(victim, "SIGKILL");
		await waitFor(() => !alive(victim), "the victim to die");
		if (stage !== "owned") assert.ok(fs.existsSync(f.socketPath()), "the killed proxy left its channel socket behind");
		const next = await f.client({ operation: "which", connectMs: CONNECT_MS }).ack(60_000);
		assert.equal(next.ending.ending, "answered", JSON.stringify(next.ending));
		assert.notEqual(next.ending.answer.pid, victim, "a new proxy serves");
		assert.ok(next.preparedMs < CONNECT_MS, `replaced within ${CONNECT_MS} ms, in ${Math.round(next.preparedMs)} ms`);
	});
}

test("a proxy paused with SIGSTOP keeps ownership: no second proxy starts, and a command ends not-delivered with proxy-unreachable at its connect deadline", { timeout: 120_000 }, async () => {
	const f = make();
	const served = await f.client({ operation: "which" }).ack();
	const owner = served.ending.answer.pid;
	process.kill(owner, "SIGSTOP");
	try {
		const connectMs = 1500;
		const ack = await f.client({ operation: "which", connectMs }).ack(60_000);
		assert.deepEqual(ack.ending, { ending: "not-delivered", invocation: null, attempt: null, operation: null, agpCode: null, proxyCode: "proxy-unreachable", earlierAttemptsUncertain: false });
		assert.ok(ack.preparedMs >= connectMs - 5, `not before the connect deadline: ${ack.preparedMs} ms`);
		const starters = f.started().filter((pid) => pid !== owner);
		for (const pid of starters) await waitFor(() => f.exits().has(pid), `starter ${pid} to exit`);
		assert.deepEqual(f.owners(), [owner], "no second proxy took the key");
		for (const pid of starters) assert.equal(f.exits().get(pid), 0);
	} finally {
		process.kill(owner, "SIGCONT");
	}
	const resumed = await f.client({ operation: "which" }).ack();
	assert.equal(resumed.ending.answer.pid, owner, "the paused owner, resumed, serves again");
});

test("the proxy is launched detached from its client with its output discarded, and outlives the client that launched it", { timeout: 60_000 }, async () => {
	const f = make();
	const c = f.client({ operation: "which" });
	const ack = await c.ack();
	await c.exited;
	const pid = ack.ending.answer.pid;
	assert.ok(alive(pid), "the proxy runs after its client exited");
	for (const fd of [0, 1, 2]) assert.equal(fs.readlinkSync(`/proc/${pid}/fd/${fd}`), "/dev/null", `its stream ${fd} is discarded`);
	const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
	assert.equal(Number(stat[3]), pid, "it leads its own process group, detached from its client's");
	assert.equal((await f.client({ operation: "which" }).ack()).ending.answer.pid, pid, "a later command reaches it");
});

