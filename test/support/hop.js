// hop - the client half and the proxy half in one process over a real channel socket (a Unix domain socket in
// a fresh temporary directory), the proxy's caller operation-call's own over AGP's production in-process
// carrier, every part on one hop clock (CONTRACT.md, PX5, PX6, PX10). Needs Unix sockets.
//
// The proxy's caller is wrapped to record the direct call the proxy makes for each invocation - the moment
// it was made, its bound, its abort signal and when that fired, and its ending - so a case checks the ending
// the client half gives against that call (zorg's D48). Taps on the proxy's side of the socket record the
// whole wire in both directions and can hold a message in transit: `inbound(value, deliver)` sees each
// message the proxy half is about to read, `outbound(message, write)` each it is about to write; a tap calls
// the function it is given now or later, or never.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCaller } from "@apnex/operation-call";
import { callClockOf, createProxyClient, createProxyHalf } from "@apnex/operation-proxy";
import { connectChannel, listenChannel, socketLink } from "../../dist/machine-channel-adapter.js";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { openTopology } from "./topology.js";

export const KEY = Object.freeze({ application: "fixture", identity: "alice", target: "loopback proxy -> host-a, host-b" });

/** A fresh short temporary directory, for a channel socket path well within 107 bytes. */
export function shortTempDir(prefix = "opx-") {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Opens a hop. Options: clock, the hop clock every part reads; allowanceMs, the client half's hop allowance
 * (default 50); holdDeliveryReports; idleMs and onIdle for the proxy half; readiness, a promise the proxy
 * awaits before its caller is ready; inbound and outbound taps; connect, a wrapper of the client's connector;
 * wrapCaller, a wrapper of the proxy's recording caller, for a case whose proxy's caller misbehaves.
 */
export async function openHop(options) {
	const clock = options.clock;
	const t = options.topology ?? await openTopology({ holdDeliveryReports: options.holdDeliveryReports });
	const dir = shortTempDir();
	const socketPath = path.join(dir, "channel.sock");
	const callClock = callClockOf(clock);
	const inner = await createCaller({ node: t.sendingNode, clock: callClock });
	const calls = [];
	const recording = {
		invoke(call) {
			const record = { at: clock.nowNs(), call, bound: call.bound, abortedAtCall: call.signal?.aborted === true, abortedAt: undefined, ending: undefined, endedAt: undefined };
			call.signal?.addEventListener("abort", () => { record.abortedAt ??= clock.nowNs(); });
			calls.push(record);
			const ending = inner.invoke(call);
			ending.then((e) => { record.ending = e; record.endedAt = clock.nowNs(); }, () => undefined);
			return ending;
		},
	};
	const wire = [];
	const proxyLinks = [];
	const half = createProxyHalf({ key: KEY, clock, idleMs: options.idleMs ?? 86_400_000, onIdle: options.onIdle ?? (() => undefined) });
	const inbound = options.inbound ?? ((_value, deliver) => deliver());
	const outbound = options.outbound ?? ((_message, write) => write());
	const server = await listenChannel(socketPath, (socket) => {
		let handlers;
		const link = socketLink(socket, {
			message: (value) => { wire.push({ to: "proxy", message: value }); inbound(value, () => handlers.message(value)); },
			closed: () => handlers.closed(),
		});
		proxyLinks.push(link);
		handlers = half.accept({
			write: (message) => { let ok = true; outbound(message, () => { wire.push({ to: "client", message }); ok = link.write(message); }); return ok; },
			close: () => link.close(),
			hold: (keep) => link.hold(keep),
		});
	});
	let launches = 0;
	const baseConnector = { connect: (handlers) => connectChannel(socketPath, handlers), launch: () => { launches++; } };
	const connector = options.connect ? options.connect(baseConnector) : baseConnector;
	const client = createProxyClient({ key: KEY, hopAllowanceMs: options.allowanceMs ?? 50, connector, clock, identities: machineIdentities });
	const becomeReady = async () => {
		await options.readiness;
		half.ready(options.wrapCaller ? options.wrapCaller(recording) : recording, callClock);
	};
	const ready = becomeReady();
	return {
		t, clock, client, half, calls, wire, socketPath, dir, ready, server, proxyLinks,
		launches: () => launches,
		/** The messages of one type on the wire, in order. */
		sent: (type) => wire.filter((w) => w.message?.type === type).map((w) => w.message),
		async close() {
			client.close();
			half.stopIdle();
			half.closeAll();
			await new Promise((resolve) => server.close(() => resolve()));
			await inner.close();
			if (!options.topology) await t.close();
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
