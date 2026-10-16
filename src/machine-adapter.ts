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
 * the ownership socket last, so the next owner can take the key only after the last step. A start that fails
 * after taking ownership - an observer throwing at `owned` or `listening`, or a clock reading failing, included -
 * stops its idle timer and closes what it opened, its connections, the channel's server and then ownership, before
 * its failure is given, so a later start in this process owns the key.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { CallClock, IdentitySource } from "@apnex/operation-call";
import { observePromises } from "@apnex/shape-check";
import type { LinkHandlers } from "./channel-link.js";
import { createProxyClient, checkHopAllowance, DEFAULT_HOP_ALLOWANCE_MS, type ProxyClient } from "./client-half.js";
import { callClockOf, type HopClock, type PinnableCallClock } from "./hop-clock.js";
import { checkKey, keyDigest, type ProxyKey } from "./key.js";
import { connectChannel, listenChannel, socketLink } from "./machine-channel-adapter.js";
import { machineClock, machineIdentities } from "./machine-clock-adapter.js";
import { channelPath, ensureRuntime, ownershipName, runtimeDirectory, RuntimeUnsafe } from "./machine-runtime-adapter.js";
import { checkIdleTime, createProxyHalf, type CallLayerCaller, type ProxyHalf } from "./proxy-half.js";

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
	readonly caller: CallLayerCaller;
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
	/**
	 * Resolves with the exit status once the proxy has stopped, and never rejects: 0, or 1 when its caller could not
	 * be built or made ready, or a step of stopping failed (PX7).
	 */
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

/** Closes a server: resolves once it is closed, and rejects when closing it fails. */
function closeServer(server: net.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
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
	/**
	 * The one shutdown, or the undoing of a failed start: it exists before any timer or callback that can start it
	 * is armed, so one firing at any moment finds it (PX7).
	 */
	let shutdown: Promise<void> | undefined;
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
	let server: net.Server | undefined;
	let callClock: PinnableCallClock;
	try {
		observe("owned");
		removeLeftover(socketPath);
		server = await listenChannel(socketPath, accept);
		half = createProxyHalf({ key, clock, idleMs, onIdle: () => void stopNow(0) });
		observe("listening");
		// The call clock reads the clock for its origin, so a clock that fails here fails the start (PX7).
		callClock = callClockOf(clock);
	} catch (error) {
		// A start that fails after taking ownership - at any step, a clock reading included - stops its idle timer,
		// closes its connections, the channel's server and then ownership, before its failure is given, so a later
		// start, in this process or another, owns the key (PX7).
		await unstart(server, half);
		throw error;
	}
	const channel: net.Server = server;
	const proxyHalf: ProxyHalf = half;
	/**
	 * Awaits `fn()` only when it returns a native `Promise` (D54, D55), wrapping the settled value in `{ value }`
	 * so an outer `async` function never assimilates a non-native thenable.
	 */
	const awaitNative = async (fn: () => unknown): Promise<{ readonly value: unknown }> => {
		let raw: unknown;
		try {
			raw = fn();
		} catch (error) {
			observePromises(error);
			throw error;
		}
		let native = false;
		try {
			native = raw instanceof Promise;
		} catch (error) {
			observePromises(error);
			observePromises(raw);
			throw error;
		}
		if (!native) return { value: raw };
		try {
			return await (Reflect.apply(Promise.prototype.then, raw, [
				(resolved: unknown) => ({ value: resolved }),
				(error: unknown) => {
					observePromises(error);
					throw error;
				},
			]) as Promise<{ readonly value: unknown }>);
		} catch (error) {
			observePromises(error);
			observePromises(raw);
			throw error;
		}
	};
	/** Validates a settled `buildCaller` result without invoking getters or `then`. */
	const validBuiltCaller = (candidate: unknown): candidate is ProxiedCaller => {
		if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
		try {
			const proto = Object.getPrototypeOf(candidate);
			if (proto !== Object.prototype && proto !== null) return false;
			if (Object.getOwnPropertyDescriptor(candidate, "then") !== undefined) return false;
			const callerDesc = Object.getOwnPropertyDescriptor(candidate, "caller");
			const stopDesc = Object.getOwnPropertyDescriptor(candidate, "stop");
			if (callerDesc === undefined || !Object.hasOwn(callerDesc, "value") || typeof callerDesc.value !== "object" || callerDesc.value === null) return false;
			if (stopDesc === undefined || !Object.hasOwn(stopDesc, "value") || typeof stopDesc.value !== "function") return false;
			const invokeDesc = Object.getOwnPropertyDescriptor(callerDesc.value, "invoke");
			return invokeDesc !== undefined && Object.hasOwn(invokeDesc, "value") && typeof invokeDesc.value === "function";
		} catch (error) {
			observePromises(error);
			return false;
		}
	};
	let built: ProxiedCaller | undefined;
	const building = (async () => {
		const { value: candidate } = await awaitNative(() => application.buildCaller(key, { clock: callClock }));
		if (!validBuiltCaller(candidate)) {
			observePromises(candidate);
			throw new TypeError("buildCaller must return a plain object with caller.invoke and stop functions");
		}
		built = candidate;
		observe("built");
		return built;
	})();
	building.then(async (caller) => {
		const { value: readyValue } = await awaitNative(() => application.callerReady(caller));
		// PX9, Amendment 2 item 1: callerReady completes when it settles to undefined; anything else fails startup.
		if (readyValue !== undefined) {
			observePromises(readyValue);
			throw new TypeError("callerReady must settle to undefined");
		}
		if (stopping) return;
		proxyHalf.ready(caller.caller, callClock);
		observe("ready");
	}).catch((error) => {
		observePromises(error);
		void stopNow(1);
	});

	/**
	 * Undoes a start that failed after taking ownership: no connection is accepted any more, the proxy half's
	 * idle timer is stopped and its connections closed, the channel's server is closed and its socket removed,
	 * and ownership is released last; each step runs on its own, so one that fails keeps no later one from running.
	 */
	async function unstart(opened: net.Server | undefined, made: ProxyHalf | undefined): Promise<void> {
		stopping = true;
		// No shutdown follows a start undone: an idle timer firing after this starts nothing.
		shutdown = Promise.resolve();
		const step = async (action: () => unknown): Promise<void> => {
			try {
				await action();
			} catch (err) {
				// The start's own failure is what is given; this step's leaves the later steps to run.
				observePromises(err);
			}
		};
		await step(() => made?.stopIdle());
		await step(() => made?.closeAll());
		for (const socket of sockets) await step(() => socket.destroy());
		if (opened !== undefined) {
			await step(() => closeServer(opened));
			await step(() => fs.rmSync(socketPath, { force: true }));
		}
		await step(() => closeServer(held));
	}

	/**
	 * The one shutdown: started once, by the idle timer, by a request once drained, or by a caller that could not be
	 * built or made ready, and never rejecting, so no path that starts it leaves a rejection unobserved. It ends
	 * with `stopped` resolved, whatever step failed.
	 */
	function stopNow(status: number): Promise<void> {
		if (shutdown === undefined) {
			stopping = true;
			shutdown = stopSteps(status).then(resolveStopped, () => resolveStopped(1));
		}
		return shutdown;
	}

	/**
	 * The stopping steps of PX7, in order, ownership released last. A step that fails - closing the channel's
	 * server, removing its socket, releasing ownership - is recorded, and the steps after it still run, so the
	 * caller is still stopped and ownership still released; the status is then 1. A caller that fails to stop
	 * still stops the proxy, as before.
	 */
	async function stopSteps(status: number): Promise<number> {
		let failed = false;
		/** One step: its failure, thrown or rejected, is recorded, and stopping goes on. */
		const step = async (action: () => unknown, fails = true): Promise<void> => {
			try {
				await action();
			} catch (err) {
				observePromises(err);
				if (fails) failed = true;
			}
		};
		await step(() => observe("stopping"));
		await step(() => proxyHalf.stopIdle());
		let closing: Promise<void> = Promise.resolve();
		await step(() => {
			closing = closeServer(channel);
			// Observed here at once; its failure is recorded when it is awaited below.
			closing.catch(() => undefined);
		});
		await step(() => proxyHalf.closeUnwelcomed());
		await step(() => proxyHalf.closeAll());
		await step(async () => {
			const flushed = Promise.all([...sockets].map((s) => new Promise<void>((resolve) => s.once("close", () => resolve()))));
			const late = setTimeout(() => { for (const s of sockets) s.destroy(); }, 2000);
			try {
				await flushed;
			} finally {
				clearTimeout(late);
			}
		});
		await step(() => closing);
		await step(() => fs.rmSync(socketPath, { force: true }));
		await step(() => observe("channel-closed"));
		// No caller was built when building failed, so there is none to stop.
		await step(() => building, false);
		await step(() => built?.stop(), false);
		await step(() => observe("caller-stopped"));
		await step(() => closeServer(held));
		await step(() => observe("stopped"));
		return failed ? 1 : status;
	}

	return Object.freeze({
		owner: true,
		stopped,
		stop(): void {
			if (stopping || draining) return;
			draining = true;
			proxyHalf.drained().then(() => stopNow(0)).catch(() => undefined);
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
