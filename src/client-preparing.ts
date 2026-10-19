/**
 * The client half's preparing (CONTRACT.md, PX3, PX5, PX6): connecting to the key's channel, sending `hello`
 * and receiving `welcome`, launching the proxy when there is nothing to connect to.
 *
 * Every invocation or `prepare` that needs a welcomed connection waits as a waiter with its own deadline.
 * While any waits, one loop connects; when nothing answers - nothing listening, or a connection closed
 * before `welcome`, which is no proxy at all - it launches the proxy with the application's command, at most
 * every 500 milliseconds, and connects again every 100 milliseconds. A `welcome`, a `refused` or an unsafe
 * runtime directory is delivered to every waiter whose deadline has not passed on the clock as it is read;
 * a waiter whose deadline has passed learns only that it came late, since an event happens when it occurs
 * on the clock, not when its callback runs (EM12). A waiter whose deadline passes is withdrawn by its own
 * timer, and when none is left the loop stops and closes a connection still waiting for `welcome`.
 *
 * The preparer owns every failure of its loop, so none goes unobserved and none keeps an outcome from its
 * waiters: a clock reading that fails as an outcome is observed is a fault of the port, which shows no deadline
 * passed, so the outcome is delivered as observed (EM12); one waiter that throws as it settles keeps no other
 * from settling; a connection attempt that fails is no proxy at all; and a wait between attempts that cannot
 * be armed ends the loop, leaving each waiter to its own deadline, as one that the loop's backstop catches does.
 * Nothing here is particular to one runtime.
 */
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { readProxyMessage, readWelcomeOrRefused, writeHello, type InvokeFields, writeAbort, writeInvoke, type RefusalCode } from "./channel-messages.js";
import type { CarriedEnding, JsonValue } from "./endings.js";
import { atMoment, msToNs, type HopClock, type HopTimer } from "./hop-clock.js";
import type { ProxyKey } from "./key.js";

/** How often the client half connects again while nothing answers (PX3). */
export const RECONNECT_MS = 100;
/** How often, at most, the client half launches the proxy (PX3). */
export const RELAUNCH_MS = 500;

/** What a connection attempt found. */
export type ConnectOutcome =
	| { readonly kind: "connected"; readonly link: ChannelLink }
	| { readonly kind: "absent" }
	| { readonly kind: "unsafe" };

/** How the client half reaches its proxy: the adapter's way to connect, and to launch it (PX2, PX3). */
export interface ClientConnector {
	/**
	 * Attempts one connection to the key's channel: a link, once connected, whose messages go to the handlers;
	 * `absent` when nothing listens there; `unsafe` when the runtime directory, its secret or the channel's
	 * path is refused (PX2).
	 */
	connect(handlers: LinkHandlers): Promise<ConnectOutcome>;
	/** Launches the proxy with the command the application supplies, detached and with its output discarded. */
	launch(): void;
}

/** An invocation written on a connection, waiting for its `end`. */
export interface WrittenInvocation {
	readonly invocation: string;
	readonly operation: string;
	/** True when it is written with `parts` true, so a `part` and an `alive` of it fit the table (PX4). */
	readonly parts: boolean;
	/** Its `end` was read; whether it is taken is the invocation's to decide by its deadline. */
	ended(ending: CarriedEnding): void;
	/** Its next `part` was read, in order; whether it is taken is the invocation's to decide (PX5). */
	part(sequence: number, answer: JsonValue): void;
	/** An `alive` of it was read; whether it is taken is the invocation's to decide (PX5). */
	alive(): void;
	/** The connection closed, or carried a malformed line, after the invocation was written. */
	lost(): void;
}

/** A welcomed connection. */
export class Connection {
	#open = true;
	#next = 1;
	#waiting = 0;
	/** Every request written and not yet ended by an `end`, decided or not. */
	readonly #asked = new Map<number, Asked>();

	constructor(readonly link: ChannelLink, private readonly gone: (connection: Connection) => void) {}

	get open(): boolean {
		return this.#open;
	}

	/**
	 * Writes an invocation under the next request number; the number, or undefined when the connection was
	 * already closed and nothing of it was written.
	 *
	 * The invocation is counted as waiting, and the connection held, before the channel's write is given it,
	 * since a channel may deliver its `end`, or the connection's close, during that write (PX4). Nothing written,
	 * that is undone once; an `end` read during the write has already released it; a close reported during the
	 * write leaves the invocation's outcome to this method, which knows whether anything of it was written.
	 */
	write(written: WrittenInvocation, fields: Omit<InvokeFields, "request">): number | undefined {
		if (!this.#open) return undefined;
		const request = this.#next++;
		const entry: Asked = { written, decided: false, writing: true, nextSequence: 1 };
		this.#asked.set(request, entry);
		this.#waiting++;
		this.link.hold(true);
		let wrote: boolean;
		try {
			wrote = this.link.write(writeInvoke({ request, ...fields }));
		} catch (error) {
			this.#undo(request, entry);
			throw error;
		}
		entry.writing = false;
		if (!wrote) {
			// The connection is already closed, though its closing may not yet have been reported.
			this.#undo(request, entry);
			this.closed();
			return undefined;
		}
		// Written, and the connection closed as it was written: the invocation is lost (PX6).
		if (!this.#open && !entry.told) {
			entry.told = true;
			entry.written.lost();
		}
		return request;
	}

	/** Undoes, once, an invocation's waiting and its entry, when nothing of it was written. */
	#undo(request: number, entry: Asked): void {
		entry.writing = false;
		entry.told = true;
		if (this.#asked.get(request) === entry) this.#asked.delete(request);
		this.#release(entry);
	}

	/** Relays an abort for a request written on this connection. */
	abort(request: number): void {
		if (this.#open) this.link.write(writeAbort(request));
	}

	/**
	 * The invocation of a request decided its ending; the connection holds its process only while one waits.
	 * Idempotent: a request already decided, or whose `end` was already read, changes nothing.
	 */
	decided(request: number): void {
		const entry = this.#asked.get(request);
		if (entry !== undefined) this.#release(entry);
	}

	/** Releases a request's part in holding the process, once, while its entry is still present. */
	#release(entry: { decided: boolean }): void {
		if (entry.decided) return;
		entry.decided = true;
		if (--this.#waiting === 0) this.link.hold(false);
	}

	/**
	 * A message read once welcomed: only an `end`, a `part` or an `alive` for a request written and not yet ended
	 * fits the table, a `part` and an `alive` only for one written with `parts` true and a part only with the next
	 * `sequence`, which it advances (PX4). It is checked first, and then given to its invocation, which takes it or
	 * discards it as late; a message that breaks the table closes the connection whatever its invocation decided.
	 * Reading an `end` decides the request, so its accounting is released before its entry is removed.
	 */
	readonly message = (value: unknown): void => {
		if (!this.#open) return;
		const read = readProxyMessage(value, (request) => {
			const asked = this.#asked.get(request);
			return asked === undefined ? undefined : { invocation: asked.written.invocation, operation: asked.written.operation, parts: asked.written.parts, nextSequence: asked.nextSequence };
		});
		const entry = read === undefined ? undefined : this.#asked.get(read.request);
		if (read === undefined || entry === undefined) {
			this.link.close();
			return;
		}
		if (read.type === "part") {
			entry.nextSequence++;
			entry.written.part(read.sequence, read.answer);
			return;
		}
		if (read.type === "alive") {
			entry.written.alive();
			return;
		}
		this.#release(entry);
		this.#asked.delete(read.request);
		entry.told = true;
		entry.written.ended(read.ending);
	};

	/** The connection closed: every invocation written on it and still waiting is lost. */
	readonly closed = (): void => {
		if (!this.#open) return;
		this.#open = false;
		this.gone(this);
		const entries = [...this.#asked.values()];
		this.#asked.clear();
		for (const entry of entries) entry.decided = true;
		const held = this.#waiting > 0;
		this.#waiting = 0;
		if (held) guarded(() => this.link.hold(false));
		// One being written is left to write, which knows whether anything of it was written.
		for (const entry of entries) {
			if (entry.writing || entry.told) continue;
			entry.told = true;
			entry.written.lost();
		}
	};
}

/** A request written, or being written, on a connection and not yet ended by an `end`. */
interface Asked {
	readonly written: WrittenInvocation;
	/** Its part in holding the process has been released. */
	decided: boolean;
	/** The channel's write has been given it and has not yet returned. */
	writing: boolean;
	/** Its invocation has been told its `end` or its loss, or nothing of it was written: it is told nothing more. */
	told?: boolean;
	/** The `sequence` its next part must hold (PX4). */
	nextSequence: number;
}

/** What a waiter learns. */
export type Prepared =
	| { readonly kind: "ready"; readonly connection: Connection }
	| { readonly kind: "refused"; readonly code: RefusalCode }
	| { readonly kind: "unsafe" }
	/** The outcome was observed at or after the waiter's deadline, which therefore came first. */
	| { readonly kind: "late" };

/** One invocation or `prepare` waiting for a welcomed connection. */
export interface Waiter {
	readonly deadline: bigint;
	settle(prepared: Prepared): void;
}

/**
 * What one attempt to connect found; an outcome a waiter learns carries the moment it was read, or undefined
 * when the clock port could not give that reading.
 */
type Attempt = (Prepared & { readonly at?: bigint | undefined }) | { readonly kind: "absent" } | { readonly kind: "dropped" } | { readonly kind: "abandoned" };

/** Runs one step on its own: a step that throws changes nothing already decided, nor any step after it. */
function guarded(step: () => void): void {
	try {
		step();
	} catch {
		// What the step left behind finds its waiter settled.
	}
}

/** The client half's preparing: one welcomed connection at a time, and the loop that obtains it. */
export class Preparer {
	#current: Connection | undefined;
	readonly #waiters = new Set<Waiter>();
	readonly #links = new Set<ChannelLink>();
	#running = false;
	#lastLaunch: bigint | undefined;
	#abandon: (() => void) | undefined;
	#wake: (() => void) | undefined;

	constructor(private readonly key: ProxyKey, private readonly connector: ClientConnector, private readonly clock: HopClock) {}

	/** The welcomed connection, while it is open. */
	get current(): Connection | undefined {
		return this.#current?.open === true ? this.#current : undefined;
	}

	/** Adds a waiter, starting the loop if it is not running. */
	wait(waiter: Waiter): void {
		this.#waiters.add(waiter);
		// The loop observes its own failures; this backstop observes one it could not foresee, which ends the loop
		// and leaves each waiter to its own deadline.
		if (!this.#running) this.#loop().catch(() => undefined);
	}

	/** Withdraws a waiter; with none left, a connection still waiting for `welcome` is closed and the loop stops. */
	withdraw(waiter: Waiter): void {
		this.#waiters.delete(waiter);
		if (this.#waiters.size > 0) return;
		this.#abandon?.();
		this.#wake?.();
	}

	/** Closes every connection the client half holds. */
	close(): void {
		for (const link of [...this.#links]) link.close();
	}

	/** The clock as it reads now, or undefined when the port cannot give a reading, a fault of the port (EM12). */
	#read(): bigint | undefined {
		try {
			return this.clock.nowNs();
		} catch {
			return undefined;
		}
	}

	/**
	 * Delivers an outcome to every waiter: those whose deadline had passed on the clock when the outcome was read
	 * learn it came late; with no reading, nothing shows a deadline passed, and the outcome observed decides. Each
	 * waiter settles on its own, so one that throws keeps no other from its outcome.
	 */
	#deliver(prepared: Prepared, at: bigint | undefined): void {
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const waiter of waiters) guarded(() => waiter.settle(at !== undefined && at >= waiter.deadline ? { kind: "late" } : prepared));
	}

	async #loop(): Promise<void> {
		this.#running = true;
		try {
			while (this.#waiters.size > 0) {
				let attempt: Attempt;
				try {
					attempt = await this.#attempt();
				} catch {
					// An attempt that failed found no proxy.
					attempt = { kind: "dropped" };
				}
				if (attempt.kind === "ready") {
					this.#current = attempt.connection;
					this.#deliver({ kind: "ready", connection: attempt.connection }, attempt.at);
				} else if (attempt.kind === "refused") {
					this.#deliver({ kind: "refused", code: attempt.code }, attempt.at);
				} else if (attempt.kind === "unsafe") {
					this.#deliver({ kind: "unsafe" }, this.#read());
				} else if (attempt.kind === "absent" || attempt.kind === "dropped") {
					const now = this.#read();
					if (now === undefined || this.#lastLaunch === undefined || now - this.#lastLaunch >= msToNs(RELAUNCH_MS)) {
						this.#lastLaunch = now;
						try {
							this.connector.launch();
						} catch {
							// A command that cannot be launched leaves the waiters to their connect deadline.
						}
					}
					if (this.#waiters.size > 0 && !await this.#sleep(now)) break;
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/**
	 * Waits until the clock reads `RECONNECT_MS` after `from`, or that long by the port's timer alone when there
	 * was no reading, or until no waiter is left: true then, and false when no timer could be armed.
	 */
	#sleep(from: bigint | undefined): Promise<boolean> {
		return new Promise((resolve) => {
			let timer: HopTimer | undefined;
			const done = (slept: boolean): void => {
				this.#wake = undefined;
				guarded(() => timer?.cancel());
				resolve(slept);
			};
			this.#wake = () => done(true);
			try {
				timer = from === undefined ? this.clock.schedule(RECONNECT_MS, () => done(true)) : atMoment(this.clock, from + msToNs(RECONNECT_MS), () => done(true));
			} catch {
				done(false);
			}
		});
	}

	/** One attempt: connect, send `hello`, and wait for `welcome`, `refused` or the connection's end. */
	async #attempt(): Promise<Attempt> {
		const route: LinkHandlers = { message: () => undefined, closed: () => undefined };
		const handlers: LinkHandlers = { message: (value) => route.message(value), closed: () => route.closed() };
		let outcome;
		try {
			outcome = await this.connector.connect(handlers);
		} catch {
			outcome = { kind: "absent" } as const;
		}
		if (outcome.kind !== "connected") return outcome;
		const link = outcome.link;
		this.#links.add(link);
		route.closed = () => this.#links.delete(link);
		if (this.#waiters.size === 0) {
			link.close();
			return { kind: "abandoned" };
		}
		return new Promise<Attempt>((resolve) => {
			let finished = false;
			const finish = (attempt: Attempt): void => {
				if (finished) return;
				finished = true;
				this.#abandon = undefined;
				resolve(attempt);
			};
			const drop = (attempt: Attempt): void => {
				route.message = () => undefined;
				guarded(() => link.close());
				finish(attempt);
			};
			route.message = (value) => {
				const message = readWelcomeOrRefused(value);
				if (message?.type === "welcome") {
					const connection = new Connection(link, (gone) => {
						this.#links.delete(link);
						if (this.#current === gone) this.#current = undefined;
					});
					route.message = connection.message;
					route.closed = connection.closed;
					// Welcomed and idle until an invocation is written on it, which holds it again.
					link.hold(false);
					finish({ kind: "ready", connection, at: this.#read() });
				} else if (message?.type === "refused") {
					drop({ kind: "refused", code: message.code, at: this.#read() });
				} else {
					// Anything else before `welcome` breaks the table: no proxy at all (PX6).
					drop({ kind: "dropped" });
				}
			};
			route.closed = () => {
				this.#links.delete(link);
				finish({ kind: "dropped" });
			};
			this.#abandon = () => drop({ kind: "abandoned" });
			try {
				link.hold(true);
				if (!link.write(writeHello(this.key))) finish({ kind: "dropped" });
			} catch {
				// A connection that cannot be held or written to is no proxy at all.
				drop({ kind: "dropped" });
			}
		});
	}
}
