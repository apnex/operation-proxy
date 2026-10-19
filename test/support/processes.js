// processes - child processes of the fixture application, for the tests that need real processes and Unix
// sockets (CONTRACT.md, PX2, PX3, PX6, PX7). Every child is spawned with its standard streams ignored and
// acknowledges through a file the test polls; every wait is on real time with wide margins, since the machine
// is often loaded.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyDigest } from "@apnex/operation-proxy";
import { records as readRecords } from "../fixtures/fixture-app.js";
import { shortTempDir } from "./hop.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
export const CLIENT_MAIN = path.join(fixtures, "client-main.js");
export const PROXY_MAIN = path.join(fixtures, "proxy-main.js");

let keys = 0;

/** Sleeps for real time. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a condition holds, polling, failing after `ms` of real time. */
export async function waitFor(condition, what, ms = 20_000) {
	const end = performance.now() + ms;
	for (;;) {
		const value = condition();
		if (value) return value;
		if (performance.now() > end) throw new Error(`waited ${ms} ms for ${what}, which never happened`);
		await sleep(20);
	}
}

/** True while a process exists. */
export function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * A fresh fixture application: a temporary directory holding its runtime directory, its records and its
 * configuration, under a key of its own. Options are written into the configuration.
 */
export function fixture(options = {}) {
	const root = shortTempDir();
	const records = path.join(root, "records");
	fs.mkdirSync(records);
	const key = options.key ?? { application: "fixture", identity: `agent-${process.pid}-${++keys}`, target: "fixture host-a" };
	const config = { key, idleMs: 60_000, hopAllowanceMs: 50, runtimeDir: path.join(root, "rt"), records, ...options, ...(options.key ? {} : { key }) };
	const configFile = path.join(root, "config.json");
	const write = () => fs.writeFileSync(configFile, JSON.stringify(config));
	write();
	let calls = 0;
	const f = {
		root, records, config, configFile,
		digest: keyDigest(config.key),
		/** The key's channel socket, in the fixture's runtime directory. */
		socketPath: () => path.join(config.runtimeDir, `${keyDigest(config.key)}.sock`),
		/** Changes the configuration later processes read. */
		set(values) { Object.assign(config, values); write(); },
		/** Every stage every proxy recorded, in order. */
		stages: () => readRecords(path.join(records, "stages.ndjson")),
		/** Every run the fixture host recorded. */
		runs: () => readRecords(path.join(records, "runs.ndjson")),
		/** Every run whose signal fired at the fixture host, a cancel among the causes. */
		aborts: () => readRecords(path.join(records, "aborts.ndjson")),
		/** The process ids that took ownership. */
		owners: () => f.stages().filter((s) => s.stage === "owned").map((s) => s.pid),
		/** The processes that started as proxies. */
		started: () => f.stages().filter((s) => s.stage === "started").map((s) => s.pid),
		/** The exit status each proxy recorded, by process id. */
		exits: () => new Map(f.stages().filter((s) => s.stage === "exit").map((s) => [s.pid, s.status])),
		/** Whether a proxy recorded a stage. */
		reached: (pid, stage) => f.stages().some((s) => s.pid === pid && s.stage === stage),
		/** Starts a client process for a call; gives the child and a wait for its acknowledgement. */
		client(call, env) {
			const n = ++calls;
			const callFile = path.join(root, `call-${n}.json`);
			const ackFile = path.join(root, `ack-${n}.json`);
			fs.writeFileSync(callFile, JSON.stringify(call));
			const child = spawn(process.execPath, [CLIENT_MAIN, configFile, ackFile, callFile], { stdio: "ignore", env: env ?? process.env });
			const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
			return {
				child, exited, ackFile,
				acked: () => fs.existsSync(ackFile),
				ack: async (ms = 30_000) => {
					await waitFor(() => fs.existsSync(ackFile), `client ${n}'s acknowledgement`, ms);
					return JSON.parse(fs.readFileSync(ackFile, "utf8"));
				},
			};
		},
		/** Starts a proxy process directly, as a client's launch would. */
		proxy(extra = []) {
			const child = spawn(process.execPath, [PROXY_MAIN, configFile, ...extra], { stdio: "ignore", detached: true });
			const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
			return { child, exited };
		},
		/** Kills every proxy and client still running, and removes the fixture's directory. */
		async cleanup() {
			for (const pid of new Set(f.started())) {
				try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
				try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
			}
			await sleep(50);
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
	return f;
}
