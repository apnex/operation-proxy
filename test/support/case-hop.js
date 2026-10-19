// case-hop - a hop opened for one case of proxied-invocation.test.js (CONTRACT.md, PX4 to PX6): the client
// half and the proxy half in one process over a real channel socket, on a manual hop clock unless the case
// gives another, with fixture hosts on both host nodes - host-a serving under `fixture` and `other` - and every
// fixture operation ready to call. Needs Unix sockets.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { callClockOf, createProxyClient } from "@apnex/operation-proxy";
import { connectChannel } from "../../dist/machine-channel-adapter.js";
import { machineIdentities } from "../../dist/machine-clock-adapter.js";
import { readyAll, openFixtureHost } from "./fixture-hosts.js";
import { KEY, openHop, shortTempDir } from "./hop.js";
import { createManualHopClock, ns } from "./manual-hop-clock.js";

export { ns };

/** A turn of the event loop, after pending I/O callbacks. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Waits a number of turns, so the socket and AGP carry what the last step started. */
export async function settle(turns = 30) {
	for (let i = 0; i < turns; i++) await turn();
}

/** Waits until a condition holds, failing after a bounded real time rather than hanging. */
export async function until(condition, what, ms = 10_000) {
	const end = performance.now() + ms;
	while (!condition()) {
		if (performance.now() > end) throw new Error(`waited for ${what}, which never happened`);
		await turn();
	}
}

/** Watches a promise: whether and how often it settled, and its value. */
export function watch(promise) {
	let count = 0;
	let value;
	promise.then((v) => { count++; value = v; }, () => { count++; });
	return { promise, settled: () => count > 0, count: () => count, value: () => value };
}

/** Opens a case's hop. Options are openHop's; `clock` defaults to a manual hop clock. */
export async function openCase(options = {}) {
	const clock = options.clock ?? createManualHopClock();
	const hop = await openHop({ ...options, clock });
	// The hosts keep time on the hop's clock, so their signs of life move as the case moves it (EM11).
	const hostClock = callClockOf(clock);
	const a = await openFixtureHost(hop.t.hosts[0], ["fixture", "other"], hostClock);
	const b = await openFixtureHost(hop.t.hosts[1], ["fixture"], hostClock);
	await readyAll(hop.t.hooks, "host-a", ["fixture", "other"]);
	await readyAll(hop.t.hooks, "host-b");
	const c = {
		hop, clock, a, b, hooks: hop.t.hooks, client: hop.client, calls: hop.calls, wire: hop.wire,
		/** Invokes through the client half: host-a, service `fixture`, input `{}` and a bound of 1000 ms unless given. */
		call: (request) => hop.client.invoke({ host: "host-a", service: "fixture", input: {}, bound: 1000, ...request }),
		/** Invokes and waits for the ending. */
		async ended(request) {
			const w = watch(c.call(request));
			await until(w.settled, `the ending of ${request.operation}`);
			return w.value();
		},
		/** The client half's deadline sent as `deadline`, for a call invoked `atMs` after the clock's start. */
		deadline: (atMs, bound, allowance) => String(clock.start + ns(atMs + bound - allowance)),
		/** The `invoke` messages on the wire, in order. */
		invokes: () => hop.sent("invoke"),
		async close() {
			a.releaseAll();
			b.releaseAll();
			await hop.close();
		},
	};
	return c;
}

/** Runs a case body with a hop, closing it whatever happens. */
export async function withCase(options, body) {
	const c = await openCase(options);
	try {
		await body(c);
	} finally {
		await c.close();
	}
}

/**
 * A raw connection to a channel socket, writing lines as given and reading every line the proxy writes,
 * for the cases about what the proxy half reads and closes on (PX4).
 */
export async function rawConnection(socketPath) {
	const socket = net.createConnection({ path: socketPath });
	await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
	const lines = [];
	let rest = "";
	let closed = false;
	socket.setEncoding("utf8");
	socket.on("data", (text) => {
		rest += text;
		let i;
		while ((i = rest.indexOf("\n")) >= 0) {
			lines.push(JSON.parse(rest.slice(0, i)));
			rest = rest.slice(i + 1);
		}
	});
	socket.on("error", () => undefined);
	socket.on("close", () => { closed = true; });
	return {
		lines,
		closed: () => closed,
		/** Stops reading, so what the proxy writes stays unread, in the kernel and then unwritten at the proxy. */
		pause: () => socket.pause(),
		/** Reads again. */
		resume: () => socket.resume(),
		write: (text) => socket.write(text),
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
		end: () => socket.destroy(),
	};
}

/**
 * A raw proxy on a channel socket of its own, for the cases about what the client half reads and closes on
 * (PX4, PX6): it welcomes each `hello`, and gives each `invoke` to `answer(invoke, line)`, where `line(text)`
 * writes raw text as one line, so a case can write what no JSON encoder writes, `1e400` among it. It counts
 * the connections that closed. `client(clock)` builds a client half reaching it.
 */
export async function rawProxy(answer) {
	const dir = shortTempDir();
	const socketPath = path.join(dir, "raw.sock");
	const sockets = new Set();
	let closes = 0;
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => { sockets.delete(socket); closes++; });
		socket.on("error", () => undefined);
		socket.setEncoding("utf8");
		let rest = "";
		socket.on("data", (text) => {
			rest += text;
			let i;
			while ((i = rest.indexOf("\n")) >= 0) {
				const message = JSON.parse(rest.slice(0, i));
				rest = rest.slice(i + 1);
				if (message.type === "hello") socket.write(`${JSON.stringify({ operationProxy: 1, type: "welcome" })}\n`);
				else if (message.type === "invoke") answer(message, (line) => socket.write(`${line}\n`));
			}
		});
	});
	await new Promise((resolve) => server.listen(socketPath, resolve));
	const clients = [];
	return {
		socketPath,
		closes: () => closes,
		client(clock) {
			const client = createProxyClient({ key: KEY, clock, identities: machineIdentities, connector: { connect: (h) => connectChannel(socketPath, h), launch: () => undefined } });
			clients.push(client);
			return client;
		},
		async close() {
			for (const client of clients) client.close();
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
			fs.rmSync(dir, { recursive: true, force: true });
		},
	};
}
