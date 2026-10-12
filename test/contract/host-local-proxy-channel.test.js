// host-local-proxy-channel - a proxy is reached only over a channel local to its host, never over the network,
// and which processes may reach it is decided by the host's own access rules on that channel (CONTRACT.md,
// PX2; zorg's E17).
//
// Needs Unix sockets, abstract-namespace sockets and child processes. Most cases use a runtime directory in a
// fresh temporary directory; the case of commands run with different HOME, TMPDIR and XDG_RUNTIME_DIR uses
// the user's own runtime directory, `.operation-proxy` in the home directory the user database records, which
// it creates if absent and leaves with its secret, as every later process of the user agrees on it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { keyDigest } from "@apnex/operation-proxy";
import { createMachineClientIn } from "../../dist/machine-adapter.js";
import { ensureRuntime, RuntimeUnsafe, runtimeDirectory } from "../../dist/machine-runtime-adapter.js";
import { shortTempDir } from "../support/hop.js";
import { alive, fixture, sleep, waitFor } from "../support/processes.js";

const SECRET_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "secret-main.js");
const fixtures = [];
const temporaries = [];
const temp = () => {
	const dir = shortTempDir();
	temporaries.push(dir);
	return dir;
};
after(async () => {
	for (const f of fixtures) await f.cleanup();
	for (const dir of temporaries) {
		try { fs.chmodSync(path.join(dir, "rt"), 0o700); } catch { /* absent */ }
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const KEY = { application: "fixture", identity: "alice", target: "nowhere" };
const LAUNCH = { command: "/bin/true" };

/** The ending of one invocation by a client half whose runtime directory is `dir`. */
function invokeIn(dir, bound = 400) {
	return createMachineClientIn(dir, { key: KEY, launch: LAUNCH }).invoke({ host: "h", service: "fixture", operation: "echo", input: 1, bound });
}

/** Asserts an ending is not delivered with the proxy's code runtime-dir-unsafe. */
function assertUnsafe(ending, what) {
	assert.deepEqual([ending.ending, ending.agpCode, ending.proxyCode, ending.attempt], ["not-delivered", null, "runtime-dir-unsafe", null], what);
}

/** Runs secret-main.js on a directory, optionally stopping at a stage, and gives the child and a wait for its ack. */
function secretProcess(dir, stage) {
	const ack = path.join(temp(), "ack.json");
	const child = spawn(process.execPath, [SECRET_MAIN, dir, ack, ...(stage ? [stage] : [])], { stdio: "ignore" });
	return {
		child,
		ackFile: ack,
		exited: new Promise((resolve) => child.once("exit", resolve)),
		ack: async () => {
			await waitFor(() => fs.existsSync(ack), "the secret process's acknowledgement");
			return JSON.parse(fs.readFileSync(ack, "utf8"));
		},
	};
}

test("the runtime directory is created with mode 0700, and in it a secret of 32 lowercase hexadecimal digits and a newline, mode 0600, and the key's channel socket", { timeout: 60_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	const previous = process.umask(0o022);
	try {
		await f.client({ operation: "which" }).ack();
	} finally {
		process.umask(previous);
	}
	const dir = fs.statSync(f.config.runtimeDir);
	assert.equal(dir.mode & 0o777, 0o700);
	assert.equal(dir.uid, process.getuid());
	const secret = fs.statSync(path.join(f.config.runtimeDir, "secret"));
	assert.equal(secret.mode & 0o777, 0o600);
	assert.equal(secret.size, 33);
	assert.match(fs.readFileSync(path.join(f.config.runtimeDir, "secret"), "latin1"), /^[0-9a-f]{32}\n$/);
	assert.ok(fs.statSync(path.join(f.config.runtimeDir, `${f.digest}.sock`)).isSocket());
	assert.deepEqual(fs.readdirSync(f.config.runtimeDir).filter((n) => n.startsWith("secret.")), [], "no secret file of a process left behind");
	assert.equal(runtimeDirectory(), path.join(os.userInfo().homedir, ".operation-proxy"), "the user's runtime directory, by the user database");
});

test("a runtime directory open to its group or to others, not a directory, or not owned by the user is refused: not-delivered with runtime-dir-unsafe", async () => {
	for (const mode of [0o750, 0o705, 0o701, 0o710, 0o777]) {
		const dir = path.join(temp(), "rt");
		fs.mkdirSync(dir);
		fs.chmodSync(dir, mode);
		assertUnsafe(await invokeIn(dir), `mode ${mode.toString(8)}`);
		assert.deepEqual(fs.readdirSync(dir), [], "nothing written in it");
	}
	const file = path.join(temp(), "rt");
	fs.writeFileSync(file, "");
	assertUnsafe(await invokeIn(file), "a file");
	const target = path.join(temp(), "real");
	fs.mkdirSync(target, { mode: 0o700 });
	const link = path.join(temp(), "rt");
	fs.symlinkSync(target, link);
	assertUnsafe(await invokeIn(link), "a symbolic link to a directory");
	assert.throws(() => ensureRuntime("/proc/1/fd"), (e) => e instanceof RuntimeUnsafe && e.reason === "not-owned", "a directory of another user, with no permission for group or others");
	assertUnsafe(await invokeIn("/proc/1/fd"), "a directory of another user");
});

test("a secret that is not exactly 33 bytes of 32 lowercase hexadecimal digits and a newline is refused: not-delivered with runtime-dir-unsafe", async () => {
	const forms = ["0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789abcdef\n", "0123456789abcdef0123456789abcdef\n\n", "0123456789abcdef0123456789abcde\n", "", "0123456789abcdef0123456789abcdeg\n"];
	for (const form of forms) {
		const dir = path.join(temp(), "rt");
		fs.mkdirSync(dir, { mode: 0o700 });
		fs.writeFileSync(path.join(dir, "secret"), form, { mode: 0o600 });
		assertUnsafe(await invokeIn(dir), `the secret ${JSON.stringify(form)}`);
		assert.equal(fs.readFileSync(path.join(dir, "secret"), "latin1"), form, "left as it was");
	}
	const dir = path.join(temp(), "rt");
	fs.mkdirSync(path.join(dir, "secret"), { recursive: true });
	fs.chmodSync(dir, 0o700);
	assertUnsafe(await invokeIn(dir), "a directory named secret");
});

test("a channel socket path longer than 107 bytes is refused: not-delivered with runtime-dir-unsafe; one of 107 bytes is used", async () => {
	const base = temp();
	const suffix = `/${keyDigest(KEY)}.sock`;
	const at = (bytes) => {
		const dir = path.join(base, "d".repeat(bytes - suffix.length - base.length - 1));
		fs.mkdirSync(dir, { mode: 0o700 });
		assert.equal(Buffer.byteLength(dir + suffix), bytes);
		return dir;
	};
	const longest = at(107);
	const ending = await invokeIn(longest, 300);
	assert.equal(ending.proxyCode, "proxy-unreachable", "107 bytes: the path is used, and no proxy answers there");
	assertUnsafe(await invokeIn(at(108)), "108 bytes");
});

test("20 first-ever clients at once leave one agreed secret, whole, with no process's own file left", { timeout: 60_000 }, async () => {
	const dir = path.join(temp(), "rt");
	const processes = Array.from({ length: 20 }, () => secretProcess(dir));
	const acks = await Promise.all(processes.map((p) => p.ack()));
	const secrets = new Set(acks.map((a) => a.secret));
	assert.equal(secrets.size, 1, `one agreed secret, not ${[...secrets].join(", ")}`);
	assert.equal(fs.readFileSync(path.join(dir, "secret"), "latin1"), `${[...secrets][0]}\n`);
	await Promise.all(processes.map((p) => p.exited));
	assert.deepEqual(fs.readdirSync(dir).sort(), ["secret"]);
});

test("a client killed before linking leaves no secret, and the next writes one; a client killed after linking leaves its secret, which every later process reads", { timeout: 60_000 }, async () => {
	const before = path.join(temp(), "rt");
	const first = secretProcess(before, "written");
	const stopped = await first.ack();
	assert.equal(stopped.stage, "written");
	first.child.kill("SIGKILL");
	await first.exited;
	assert.ok(!fs.existsSync(path.join(before, "secret")), "killed before linking: no secret");
	assert.ok(fs.existsSync(stopped.ownFile), "its own file remains, never linked");
	const next = await secretProcess(before).ack();
	assert.match(next.secret, /^[0-9a-f]{32}$/);
	assert.equal((await secretProcess(before).ack()).secret, next.secret, "one agreed secret");
	const afterLink = path.join(temp(), "rt");
	const second = secretProcess(afterLink, "linked");
	const linked = await second.ack();
	assert.equal(linked.stage, "linked");
	const written = fs.readFileSync(linked.ownFile, "latin1");
	second.child.kill("SIGKILL");
	await second.exited;
	assert.equal(fs.readFileSync(path.join(afterLink, "secret"), "latin1"), written, "killed after linking: its secret is the secret, whole");
	assert.equal((await secretProcess(afterLink).ack()).secret, written.trim(), "every later process reads it");
});

test("a first-ever client whose complete secret is written after another's is linked reads the other's: the link succeeds for one process only, and secret never changes", { timeout: 60_000 }, async () => {
	const dir = path.join(temp(), "rt");
	const slow = secretProcess(dir, "pause-written");
	const paused = await slow.ack();
	assert.equal(paused.stage, "written");
	assert.ok(!fs.existsSync(path.join(dir, "secret")), "the slow client found no secret and wrote its own file");
	const fast = await secretProcess(dir).ack();
	assert.equal(fs.readFileSync(path.join(dir, "secret"), "latin1"), `${fast.secret}\n`);
	const ackFile = slow.ackFile;
	fs.rmSync(ackFile);
	process.kill(slow.child.pid, "SIGCONT");
	await slow.exited;
	const resumed = JSON.parse(fs.readFileSync(ackFile, "utf8"));
	assert.equal(resumed.secret, fast.secret, "the slow client reads the secret linked first, not its own");
	assert.equal(fs.readFileSync(path.join(dir, "secret"), "latin1"), `${fast.secret}\n`, "secret is unchanged");
	assert.deepEqual(fs.readdirSync(dir), ["secret"], "the slow client removed its own file");
});

test("the proxy listens on no network port: its sockets are its Unix channel socket and its abstract-namespace ownership socket", { timeout: 60_000 }, async () => {
	const f = fixture();
	fixtures.push(f);
	const pid = (await f.client({ operation: "which" }).ack()).ending.answer.pid;
	const inodes = new Set(fs.readdirSync(`/proc/${pid}/fd`).map((fd) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { return ""; } })
		.map((l) => /^socket:\[(\d+)\]$/.exec(l)?.[1]).filter(Boolean));
	assert.ok(inodes.size >= 2);
	for (const table of ["tcp", "tcp6", "udp", "udp6", "raw", "raw6", "udplite", "udplite6"]) {
		let lines = [];
		try { lines = fs.readFileSync(`/proc/net/${table}`, "utf8").trim().split("\n").slice(1); } catch { continue; }
		for (const line of lines) assert.ok(!inodes.has(line.trim().split(/\s+/)[9]), `the proxy holds a ${table} socket`);
	}
	const unix = fs.readFileSync("/proc/net/unix", "utf8").trim().split("\n").slice(1).map((l) => l.trim().split(/\s+/));
	const mine = unix.filter((cols) => inodes.has(cols[6])).map((cols) => cols[7]).filter(Boolean);
	const secret = fs.readFileSync(path.join(f.config.runtimeDir, "secret"), "latin1").trim();
	assert.ok(mine.includes(f.socketPath()), "it listens on the channel socket");
	assert.ok(mine.includes(`@operation-proxy-${secret}-${f.digest}`), "it holds the ownership socket, named with the secret");
});

test("commands of one key run with different HOME, TMPDIR and XDG_RUNTIME_DIR settings find one proxy, in the runtime directory the user database names", { timeout: 120_000 }, async () => {
	const f = fixture({ realHome: true });
	fixtures.push(f);
	const envs = [0, 1, 2].map((i) => {
		const home = temp();
		return { ...process.env, HOME: home, TMPDIR: path.join(home, "tmp"), XDG_RUNTIME_DIR: path.join(home, "run") };
	});
	envs.push({ ...process.env, HOME: "/nonexistent", TMPDIR: "/var/tmp", XDG_RUNTIME_DIR: "" });
	const acks = [];
	for (const env of envs) acks.push(await f.client({ operation: "which", connectMs: 20_000 }, env).ack(60_000));
	for (const ack of acks) assert.equal(ack.ending.ending, "answered", JSON.stringify(ack.ending));
	const pid = acks[0].ending.answer.pid;
	assert.deepEqual([...new Set(acks.map((a) => a.ending.answer.pid))], [pid], "one proxy for every environment");
	const dir = path.join(os.userInfo().homedir, ".operation-proxy");
	assert.ok(fs.statSync(path.join(dir, `${f.digest}.sock`)).isSocket(), "its channel is in the user's runtime directory");
	for (const env of envs.slice(0, 3)) assert.ok(!fs.existsSync(path.join(env.HOME, ".operation-proxy")), "nothing under the environment's HOME");
	process.kill(pid, "SIGTERM");
	await waitFor(() => !alive(pid), "the proxy to stop");
	await sleep(50);
	assert.ok(!fs.existsSync(path.join(dir, `${f.digest}.sock`)), "the proxy removed its channel socket");
});
