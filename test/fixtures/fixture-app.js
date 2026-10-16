// fixture-app - the fixture application of operation-proxy's tests (CONTRACT.md, PX9; zorg's E17): what an
// application supplies - its key, the command that launches its proxy, the idle time, the function that
// builds the proxy's caller from the key, and the test of when that caller is ready - for child processes.
//
// The proxy's caller is operation-call's own, on an AGP node named for the key's identity and an instance tag,
// dialling a fixture host node in the same process over AGP's production in-process carrier. The host serves
// fixture operations under `fixture` and `other`, and records every run, with the proxy's process and the
// node the request came from, to `<records>/runs.ndjson`, so a test sees what reached the host from outside.
//
// Operations: `echo` answers its input; `which` answers the proxy's process, its node and the identities it
// was given; `hold` waits until the file `<records>/release` exists, then answers like `which`; `silent`
// never answers; `gather` waits until `input.n` runs of `gather` are in flight together, then all answer.
// AGP and the call layer are loaded only when the caller is built, by the proxy that owns the key.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ANY = { $schema: "urn:apnex:shape-check:dialect:1" };
export const SERVICES = ["fixture", "other"];
const OPERATIONS = ["echo", "which", "hold", "silent", "gather"];
const REPLY = "operation-call/replies";

/** Appends one JSON record as a line, in one write, so lines from several processes never interleave. */
export function record(file, value) {
	fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

/** Every record of a file of JSON lines, or none when it does not exist. */
export function records(file) {
	try {
		return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

/** A sleep that blocks the whole thread, as a process stuck at one step is. */
export function block(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The fixture application's proxy side, as PX9 lists it. */
export function fixtureProxyApplication(config) {
	const runsFile = path.join(config.records, "runs.ndjson");
	return {
		key: config.key,
		idleMs: config.idleMs,
		async buildCaller(key, { clock }) {
			// Loaded only by the owner, so a starter that loses exits having loaded little.
			const [{ createNode }, { createLoopbackFabric }, { createCaller, createOperationHost }] = await Promise.all([
				import("@agp/node"), import("@agp/transport-loopback"), import("@apnex/operation-call"),
			]);
			record(path.join(config.records, "built.ndjson"), { pid: process.pid, key });
			const fabricId = `fixture-${process.pid}-${randomBytes(4).toString("hex")}`;
			const fabric = createLoopbackFabric({ fabricId, limits: {
				maxTransports: 4, maxListeners: 4, maxPendingAcquisitions: 4, maxActiveChannels: 4, maxPacketBytes: 16_777_216,
				maxBufferedPacketsPerChannel: 1_024, maxBufferedBytesPerChannel: 67_108_864, maxQueuedPacketsTotal: 65_536,
				maxQueuedBytesTotal: 268_435_456, maxPendingSendBytesTotal: 17_179_869_184,
			} });
			const port = (name, listen, targets) => fabric.createTransport({ transportName: name, capabilities: { listen, connect: targets.length > 0 } }).createPort({
				listeners: new Map(listen ? [["listen", { fabricId, address: name }]] : []),
				targets: new Map(targets.map((t) => [t, { fabricId, address: t }])),
			});
			const nodeId = `${key.identity}.${randomBytes(8).toString("hex")}`;
			const host = createNode({ nodeId: "host-a", listen: { transportRef: "listen" }, capacity: { maxSessions: 4, maxPendingHandshakes: 4 }, disposition: { debounceMs: 0 } }, { transport: port("host-a", true, []) });
			const proxyNode = createNode({ nodeId, capacity: { maxSessions: 4, maxPendingHandshakes: 4 }, disposition: { debounceMs: 0 },
				peers: [{ adjacencyId: "host-a", expectedNodeId: "host-a", transportRef: "host-a", reconnect: { initialDelayMs: 10, maximumDelayMs: 100 } }] }, { transport: port(nodeId, false, ["host-a"]) });
			await host.start();
			let gathering = [];
			for (const service of SERVICES) {
				const opening = await createOperationHost(host, { service });
				const who = (c) => ({ pid: process.pid, node: c.delivery.source.originNodeId, service, invocation: c.invocation, attempt: c.attempt });
				const handlers = {
					echo: (input) => ({ outcome: "answered", answer: input }),
					which: (_input, c) => ({ outcome: "answered", answer: who(c) }),
					hold: async (_input, c) => {
						while (!fs.existsSync(path.join(config.records, "release"))) await new Promise((r) => setTimeout(r, 20));
						return { outcome: "answered", answer: who(c) };
					},
					silent: (_input, c) => new Promise((_resolve, reject) => c.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
					gather: (input, c) => new Promise((resolve) => {
						gathering.push(() => resolve({ outcome: "answered", answer: { ...who(c), together: input.n } }));
						if (gathering.length >= input.n) {
							const all = gathering;
							gathering = [];
							for (const answer of all) answer();
						}
					}),
				};
				for (const name of OPERATIONS) {
					await opening.host.declare({ name, input: ANY, answers: "whole" }, (input, c) => {
						record(runsFile, { pid: process.pid, service, operation: c.operation, input, invocation: c.invocation, attempt: c.attempt, origin: c.delivery.source.originNodeId, at: Date.now() });
						return handlers[name](input, c);
					});
				}
			}
			await proxyNode.start();
			const caller = await createCaller({ node: proxyNode, clock });
			return {
				caller,
				nodeId,
				isReady() {
					const routes = proxyNode.operations.routes().candidates;
					const acked = proxyNode.operations.routeExports().items.some((r) => r.endpoint === REPLY && r.remoteNodeId === "host-a" && r.state === "acked");
					return acked && SERVICES.every((s) => OPERATIONS.every((o) => routes.some((r) => r.endpoint === `${s}/${o}` && r.originNodeId === "host-a")));
				},
				async stop() {
					record(path.join(config.records, "caller-stopped.ndjson"), { pid: process.pid });
					await caller.close();
					await Promise.allSettled([proxyNode.stop(), host.stop()]);
					await fabric.close(AbortSignal.timeout(2000));
				},
			};
		},
		async callerReady(built) {
			// Ready once every fixture endpoint is routed to the proxy's node and its reply endpoint is acknowledged.
			const ready = () => built.isReady();
			if (config.readyAfterFile) while (!fs.existsSync(config.readyAfterFile)) await new Promise((r) => setTimeout(r, 20));
			while (!ready()) await new Promise((r) => setTimeout(r, 5));
			record(path.join(config.records, "ready.ndjson"), { pid: process.pid, node: built.nodeId });
		},
	};
}
