/**
 * The machine adapter (CONTRACT.md, PX1 to PX3, PX7, PX9), for Linux: the client half reaching its proxy over
 * the key's channel socket and launching the proxy when nothing answers, and the proxy as an operating-system
 * process that owns its key through an abstract-namespace socket.
 *
 * Owning a key (PX3): a starting proxy listens on the key's ownership socket first, which the operating system
 * lets one process hold at a time and frees the moment that process ends, `SIGKILL` included; if the address
 * is in use another proxy owns the key, and this one stops, touching nothing. Only the owner touches the
 * channel socket: it removes any socket left at that path, listens there, and then builds its caller.
 *
 * Stopping (PX7): when the idle timer finds the proxy idle, and on `SIGTERM` or `SIGINT` once each call in
 * flight has ended and its ending has been sent, the proxy stops accepting connections, closes those not
 * welcomed and then the rest, closes and removes the channel socket, stops its caller, and stops listening on
 * the ownership socket last, so the next owner can take the key only after the last step.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { CallClock, IdentitySource, OperationCaller } from "@apnex/operation-call";
import type { LinkHandlers } from "./channel-link.js";
import { createProxyClient, checkHopAllowance, DEFAULT_HOP_ALLOWANCE_MS, type ProxyClient } from "./client-half.js";
import { callClockOf, type HopClock } from "./hop-clock.js";
import { checkKey, keyDigest, type ProxyKey } from "./key.js";
import { connectChannel, listenChannel, socketLink } from "./machine-channel-adapter.js";
import { machineClock, machineIdentities } from "./machine-clock-adapter.js";
import { channelPath, ensureRuntime, ownershipName, runtimeDirectory, RuntimeUnsafe } from "./machine-runtime-adapter.js";
import { checkIdleTime, createProxyHalf, type ProxyHalf } from "./proxy-half.js";

/** The command that launches an application's proxy (PX3, PX9). */
export interface LaunchCommand {
	/** The program to run. */
	readonly command: string;
	/** Its arguments, the idle time among them, since the launching command's idle time prevails (PX9). */
	readonly args?: readonly string[];
}

/** What an application supplies to the client half on a machine (PX9). */
export interface MachineClientApplication {
	readonly key: ProxyKey;
	/** The command that launches its proxy. */
	readonly launch: LaunchCommand;
	/** The hop allowance: a whole number of milliseconds from 0 to 1000, by default 50. */
	readonly hopAllowanceMs?: number;
}

/** The proxy's caller, as the application builds it from the key (PX1, PX9). */
export interface ProxiedCaller {
	/** One caller of the call layer, with its one connection to the target. */
	readonly caller: OperationCaller;
	/** Stops the caller - its node and its connection - when the proxy stops (PX7). */
	stop(): Promise<void> | void;
}

/** What an application supplies to its proxy on a machine (PX9). */
export interface MachineProxyApplication {
	readonly key: ProxyKey;
	/** The idle time, from 1 second to 24 hours, in milliseconds (PX7). */
	readonly idleMs: number;
	/**
	 * Builds the proxy's caller from the key. Its bound must run on the clock port given, so the proxy's call is
	 * bound on the clock the deadline crossed on (PX5).
	 */
	buildCaller(key: ProxyKey, ports: { readonly clock: CallClock }): Promise<ProxiedCaller> | ProxiedCaller;
	/** The application's test of when that caller is ready: resolves once it is, and the proxy then welcomes. */
	callerReady(built: ProxiedCaller): Promise<void> | void;
}

/** A moment in a proxy's life, reported to an observer as it happens. */
export type ProxyStage = "owned" | "listening" | "built" | "ready" | "stopping" | "channel-closed" | "caller-stopped" | "stopped";

/** Ports and observation for a proxy run in this process. */
export interface MachineProxyOptions {
	/** The clock the proxy reads; CLOCK_MONOTONIC by default. */
	readonly clock?: HopClock;
	/** Told each stage as it happens, synchronously. */
	readonly observe?: (stage: ProxyStage) => void;
}

/** A proxy started in this process. */
export interface MachineProxy {
	/** False when another proxy owned the key, and this one stopped, touching nothing. */
	readonly owner: boolean;
	/** Resolves with the exit status once the proxy has stopped: 0, or 1 when its caller could not be built. */
	readonly stopped: Promise<number>;
	/** Stops as on `SIGTERM`: once each call in flight has ended and its ending has been sent. */
	stop(): void;
}

/** Ports for a client half on a machine. */
export interface MachineClientOptions {
	readonly clock?: HopClock;
	readonly identities?: IdentitySource;
}

/** Checks a launch command. */
function checkLaunch(launch: unknown): LaunchCommand {
	if (launch === null || typeof launch !== "object") throw new TypeError("an application's launch is { command, args }");
	const { command, args } = launch as { command?: unknown; args?: unknown };
	if (typeof command !== "string" || command.length === 0) throw new TypeError("a launch command names a program");
	if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === "string"))) throw new TypeError("a launch command's args are strings");
	return Object.freeze({ command, args: Object.freeze([...(args as string[] | undefined) ?? []]) });
}

/** A client half on a machine whose runtime directory is `dir`. */
export function createMachineClientIn(dir: string, application: MachineClientApplication, options: MachineClientOptions = {}): ProxyClient {
	if (application === null || typeof application !== "object") throw new TypeError("a client half needs an application: { key, launch, hopAllowanceMs }");
	const key = checkKey(application.key);
	const launch = checkLaunch(application.launch);
	const hopAllowanceMs = checkHopAllowance(application.hopAllowanceMs === undefined ? DEFAULT_HOP_ALLOWANCE_MS : application.hopAllowanceMs);
	const digest = keyDigest(key);
	return createProxyClient({
		key,
		hopAllowanceMs,
		clock: options.clock ?? machineClock,
		identities: options.identities ?? machineIdentities,
		connector: {
			async connect(handlers: LinkHandlers) {
				let socketPath: string;
				try {
					ensureRuntime(dir);
					socketPath = channelPath(dir, digest);
				} catch (error) {
					if (error instanceof RuntimeUnsafe) return { kind: "unsafe" };
					throw error;
				}
				return connectChannel(socketPath, handlers);
			},
			launch(): void {
				const child = spawn(launch.command, launch.args ?? [], { detached: true, stdio: "ignore" });
				child.on("error", () => undefined);
				child.unref();
			},
		},
	});
}

/** Listens on the key's ownership socket: the server, or undefined when another process holds it (PX3). */
function own(name: string): Promise<net.Server | undefined> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => socket.destroy());
		server.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EADDRINUSE") resolve(undefined);
			else reject(error);
		});
		server.listen({ path: name, exclusive: true }, () => resolve(server));
	});
}

/** Closes a server, resolving once it is closed. */
function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

/** Removes a socket left at the channel's path by an earlier owner; anything else there is refused. */
function removeLeftover(socketPath: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!stat.isSocket()) throw new RuntimeUnsafe("unusable", `${socketPath} is not a socket, and is left as it is`);
	fs.rmSync(socketPath, { force: true });
}

/** A proxy run in this process, whose runtime directory is `dir`. */
export async function startMachineProxyIn(dir: string, application: MachineProxyApplication, options: MachineProxyOptions = {}): Promise<MachineProxy> {
	if (application === null || typeof application !== "object") throw new TypeError("a proxy needs an application: { key, idleMs, buildCaller, callerReady }");
	const key = checkKey(application.key);
	const idleMs = checkIdleTime(application.idleMs);
	if (typeof application.buildCaller !== "function" || typeof application.callerReady !== "function") throw new TypeError("an application supplies buildCaller and callerReady");
	const clock = options.clock ?? machineClock;
	const observe = (stage: ProxyStage): void => options.observe?.(stage);
	const secret = ensureRuntime(dir);
	const digest = keyDigest(key);
	const socketPath = channelPath(dir, digest);

	const sockets = new Set<net.Socket>();
	let stopping = false;
	let draining = false;
	let resolveStopped!: (status: number) => void;
	const stopped = new Promise<number>((resolve) => { resolveStopped = resolve; });
	let half: ProxyHalf | undefined;
	const accept = (socket: net.Socket): void => {
		if (stopping || half === undefined) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		let handlers: LinkHandlers | undefined;
		const link = socketLink(socket, { message: (value) => handlers?.message(value), closed: () => handlers?.closed() });
		handlers = half.accept(link);
	};

	const ownership = await own(ownershipName(secret, digest));
	if (ownership === undefined) return Object.freeze({ owner: false, stopped: Promise.resolve(0), stop: () => undefined });
	const held: net.Server = ownership;
	observe("owned");
	let server: net.Server;
	try {
		removeLeftover(socketPath);
		server = await listenChannel(socketPath, accept);
	} catch (error) {
		await closeServer(ownership);
		throw error;
	}
	half = createProxyHalf({ key, clock, idleMs, onIdle: () => void stopNow(0) });
	const proxyHalf = half;
	observe("listening");

	const callClock = callClockOf(clock);
	let built: ProxiedCaller | undefined;
	const building = (async () => {
		built = await application.buildCaller(key, { clock: callClock });
		observe("built");
		return built;
	})();
	building.then(async (caller) => {
		await application.callerReady(caller);
		if (stopping) return;
		proxyHalf.ready(caller.caller, callClock);
		observe("ready");
	}).catch(() => void stopNow(1));

	/** The stopping steps of PX7, in order, ownership released last. */
	async function stopNow(status: number): Promise<void> {
		if (stopping) return;
		stopping = true;
		observe("stopping");
		proxyHalf.stopIdle();
		const closing = new Promise<void>((resolve) => server.close(() => resolve()));
		proxyHalf.closeUnwelcomed();
		proxyHalf.closeAll();
		const flushed = Promise.all([...sockets].map((s) => new Promise<void>((resolve) => s.once("close", () => resolve()))));
		const late = setTimeout(() => { for (const s of sockets) s.destroy(); }, 2000);
		await flushed;
		clearTimeout(late);
		await closing;
		fs.rmSync(socketPath, { force: true });
		observe("channel-closed");
		try {
			await building;
		} catch {
			// No caller was built, so there is none to stop.
		}
		try {
			await built?.stop();
		} catch {
			// A caller that fails to stop still stops the proxy.
		}
		observe("caller-stopped");
		await closeServer(held);
		observe("stopped");
		resolveStopped(status);
	}

	return Object.freeze({
		owner: true,
		stopped,
		stop(): void {
			if (stopping || draining) return;
			draining = true;
			void proxyHalf.drained().then(() => stopNow(0));
		},
	});
}

/** A client half on this machine: the call layer's caller interface through the key's proxy (PX1 to PX6). */
export function createMachineClient(application: MachineClientApplication, options: MachineClientOptions = {}): ProxyClient {
	return createMachineClientIn(runtimeDirectory(), application, options);
}

/** A proxy run in this process for the key, in the user's runtime directory (PX2, PX3, PX7). */
export function startMachineProxy(application: MachineProxyApplication, options: MachineProxyOptions = {}): Promise<MachineProxy> {
	return startMachineProxyIn(runtimeDirectory(), application, options);
}

/**
 * Runs this process as the key's proxy, as the application's launching command does: it owns the key or
 * exits with status 0 touching nothing, stops on `SIGTERM` or `SIGINT` once its calls in flight have ended,
 * and exits with the proxy's status once stopped - 1 when the runtime directory is refused or its caller
 * could not be built.
 */
export async function runMachineProxy(application: MachineProxyApplication, options: MachineProxyOptions = {}): Promise<never> {
	return runProxyProcess(() => startMachineProxy(application, options));
}

/** Runs this process as a proxy started by `start`, exiting with its status. */
export async function runProxyProcess(start: () => Promise<MachineProxy>): Promise<never> {
	let proxy: MachineProxy;
	try {
		proxy = await start();
	} catch {
		process.exit(1);
	}
	if (!proxy.owner) process.exit(0);
	process.on("SIGTERM", () => proxy.stop());
	process.on("SIGINT", () => proxy.stop());
	process.exit(await proxy.stopped);
}
