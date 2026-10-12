// topology - three AGP nodes over AGP's production in-process carrier, @agp/transport-loopback: the proxy's
// caller node dialling two host nodes that listen, every node on one AGP injected clock (ManualClock), as
// operation-call's own fixture builds them (zorg's Delta 1, verification targets; E17). The proxy's caller is
// built on the caller node by the application's buildCaller, with the clock port the proxy gives it.
//
// It offers the hooks of operation-call's caller suite that are AGP's: AGP's clock, an executor barrier on any
// node, the loss of the channel between the caller's node and a host, the failure of the next send, and the
// observations a case waits on (operation-proxy's PX10).
import { ManualClock } from "@agp/core";
import { createNode } from "@agp/node";
import { createLoopbackFabric } from "@agp/transport-loopback";

const REPLY = "operation-call/replies";
let fabrics = 0;

/** A turn of the event loop. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Waits until a condition holds, failing after a bounded real time rather than hanging. */
export async function until(condition, what, ms = 10_000) {
	const end = performance.now() + ms;
	while (performance.now() < end) {
		if (condition()) return;
		await turn();
	}
	throw new Error(`waited for ${what}, which never happened`);
}

/** Builds the topology. Options: holdDeliveryReports, a host disposition debounce of 60 s with no count bound. */
export async function openTopology(options = {}) {
	const fabricId = `operation-proxy-${process.pid}-${++fabrics}`;
	const fabric = createLoopbackFabric({ fabricId, limits: {
		maxTransports: 8, maxListeners: 8, maxPendingAcquisitions: 8, maxActiveChannels: 8, maxPacketBytes: 16_777_216,
		maxBufferedPacketsPerChannel: 1_024, maxBufferedBytesPerChannel: 67_108_864, maxQueuedPacketsTotal: 65_536,
		maxQueuedBytesTotal: 268_435_456, maxPendingSendBytesTotal: 17_179_869_184,
	} });
	const agpClock = new ManualClock();
	const channels = new Map();
	const port = (name, listen, targets) => {
		const scoped = fabric.createTransport({ transportName: name, capabilities: { listen, connect: targets.length > 0 } }).createPort({
			listeners: new Map(listen ? [["listen", { fabricId, address: name }]] : []),
			targets: new Map(targets.map((t) => [t, { fabricId, address: t }])),
		});
		return {
			resolveListener: (reference) => scoped.resolveListener(reference),
			resolveTarget(reference) {
				const target = scoped.resolveTarget(reference);
				if (target === undefined) return undefined;
				return { async connect(o, signal) { const channel = await target.connect(o, signal); channels.set(reference, channel); return channel; } };
			},
		};
	};
	const capacity = { maxSessions: 4, maxPendingHandshakes: 4 };
	const timers = { holdTimeMs: 0 };
	const hostDisposition = options.holdDeliveryReports ? { debounceMs: 60_000, maximumOutcomes: 1_000_000 } : { debounceMs: 0 };
	const hostNode = (id) => createNode({ nodeId: id, listen: { transportRef: "listen" }, capacity, timers, disposition: hostDisposition }, { clock: agpClock, transport: port(id, true, []) });
	const hosts = [{ nodeId: "host-a", node: hostNode("host-a") }, { nodeId: "host-b", node: hostNode("host-b") }];
	const reconnect = { initialDelayMs: 10, maximumDelayMs: 10 };
	const callerNode = createNode({ nodeId: "proxy", capacity, timers, disposition: { debounceMs: 0 }, peers: hosts.map((h) => ({
		adjacencyId: h.nodeId, expectedNodeId: h.nodeId, transportRef: h.nodeId, reconnect,
	})) }, { clock: agpClock, transport: port("proxy", false, hosts.map((h) => h.nodeId)) });
	const nodes = new Map([["proxy", callerNode], ...hosts.map((h) => [h.nodeId, h.node])]);

	const reports = [];
	const stream = callerNode.dispositions({ source: REPLY });
	(async () => { for await (const d of stream) for (const o of d.outcomes) reports.push(o.kind); })();

	// The caller's node as the caller sees it: every send counted, one made to fail with no AGP code, unsent,
	// and an action run, when one waits, once a send is admitted.
	const afterAdmission = [];
	let requests = 0;
	let failNext = false;
	const sendingNode = {
		nodeId: callerNode.nodeId,
		operations: callerNode.operations,
		start: (...a) => callerNode.start(...a),
		stop: (...a) => callerNode.stop(...a),
		expose: (...a) => callerNode.expose(...a),
		disposition: (...a) => callerNode.disposition(...a),
		settled: (...a) => callerNode.settled(...a),
		dispositions: (...a) => callerNode.dispositions(...a),
		async send(...args) {
			requests++;
			if (failNext) {
				failNext = false;
				throw new Error("a send failed with no AGP code, by the fixture's hook");
			}
			const receipt = await callerNode.send(...args);
			afterAdmission.shift()?.();
			return receipt;
		},
	};

	const holds = new Set();
	const exportAcked = (node, endpoint, remote) => node.operations.routeExports().items.some((r) => r.endpoint === endpoint && r.remoteNodeId === remote && r.state === "acked");
	const routeVisible = (hostId, endpoint) => callerNode.operations.routes().candidates.some((r) => r.endpoint === endpoint && r.originNodeId === hostId);
	const hooks = {
		advanceAgpClock: (ms) => agpClock.advanceBy(ms),
		holdExecutor(nodeId) {
			const node = nodes.get(nodeId);
			const blocker = Promise.withResolvers();
			holds.add(blocker);
			const blocked = node.executor.run(() => blocker.promise);
			return async () => { blocker.resolve(); await blocked; await node.executor.quiesce(); };
		},
		loseChannel(hostId) { channels.get(hostId).abort({ kind: "abort" }); },
		async ready(hostId, endpoint) {
			const host = nodes.get(hostId);
			const isReady = () => routeVisible(hostId, endpoint) && exportAcked(callerNode, REPLY, hostId) && exportAcked(host, endpoint, "proxy");
			const end = performance.now() + 10_000;
			while (!isReady()) {
				if (performance.now() > end) throw new Error(`${endpoint} on ${hostId} never became ready`);
				if (!callerNode.operations.connections().items.some((c) => c.remoteNodeId === hostId && c.state === "Established")) agpClock.advanceBy(10);
				await turn();
			}
		},
		routeVisible,
		reports: () => [...reports],
		afterNextAdmission: (action) => { afterAdmission.push(action); },
		requests: () => requests,
		failNextSend: () => { failNext = true; },
	};

	for (const h of hosts) await h.node.start();
	await callerNode.start();
	await until(() => hosts.every((h) => callerNode.operations.connections().items.some((c) => c.remoteNodeId === h.nodeId && c.state === "Established")), "both sessions established");

	return {
		fabric, agpClock, callerNode, sendingNode, hosts, hooks, channels, callerNodeId: "proxy",
		async close() {
			for (const blocker of holds) blocker.resolve();
			stream.close();
			await Promise.allSettled([callerNode.stop(), ...hosts.map((h) => h.node.stop())]);
			await fabric.close(AbortSignal.timeout(5000));
		},
	};
}
