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
 * Nothing here is particular to one runtime.
 */
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { readEnd, readWelcomeOrRefused, writeHello, type InvokeFields, writeAbort, writeInvoke, type RefusalCode } from "./channel-messages.js";
import type { CarriedEnding } from "./endings.js";
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
	/** Its `end` was read; whether it is taken is the invocation's to decide by its deadline. */
	ended(ending: CarriedEnding): void;
	/** The connection closed, or carried a malformed line, after the invocation was written. */
	lost(): void;
}

/** A welcomed connection. */
export class Connection {
	#open = true;
	#next = 1;
	#waiting = 0;
	/** Every request written and not yet ended by an `end`, decided or not. */
	readonly #asked = new Map<number, { readonly written: WrittenInvocation; decided: boolean }>();

	constructor(readonly link: ChannelLink, private readonly gone: (connection: Connection) => void) {}

	get open(): boolean {
		return this.#open;
	}

	/**
	 * Writes an invocation under the next request number; the number, or undefined when the connection was
	 * already closed and nothing of it was written.
	 */
	write(written: WrittenInvocation, fields: Omit<InvokeFields, "request">): number | undefined {
		if (!this.#open) return undefined;
		const request = this.#next++;
		this.#asked.set(request, { written, decided: false });
		if (!this.link.write(writeInvoke({ request, ...fields }))) {
			// The connection is already closed, though its closing may not yet have been reported.
			this.#asked.delete(request);
			this.closed();
			return undefined;
		}
		this.#waiting++;
		this.link.hold(true);
		return request;
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
	 * A message read once welcomed: only an `end` for a request written and not yet ended fits the table. Reading
	 * it decides the request - taken, or discarded as late - so its accounting is released before its entry is
	 * removed; an `end` for a request already decided, by its deadline, is a late end, discarded.
	 */
	readonly message = (value: unknown): void => {
		if (!this.#open) return;
		const end = readEnd(value, (request) => this.#asked.get(request)?.written);
		const entry = end === undefined ? undefined : this.#asked.get(end.request);
		if (end === undefined || entry === undefined) {
			this.link.close();
			return;
		}
		this.#release(entry);
		this.#asked.delete(end.request);
		entry.written.ended(end.ending);
	};

	/** The connection closed: every invocation written on it and still waiting is lost. */
	readonly closed = (): void => {
		if (!this.#open) return;
		this.#open = false;
		this.gone(this);
		const entries = [...this.#asked.values()];
		this.#asked.clear();
		this.#waiting = 0;
		for (const entry of entries) entry.written.lost();
	};
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

/** What one attempt to connect found; an outcome a waiter learns carries the moment it was read. */
type Attempt = (Prepared & { readonly at?: bigint }) | { readonly kind: "absent" } | { readonly kind: "dropped" } | { readonly kind: "abandoned" };

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
		if (!this.#running) void this.#loop();
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

	/**
	 * Delivers an outcome to every waiter: those whose deadline had passed on the clock when the outcome was read
	 * learn it came late.
	 */
	#deliver(prepared: Prepared, at: bigint = this.clock.nowNs()): void {
		const now = at;
		const waiters = [...this.#waiters];
		this.#waiters.clear();
		for (const waiter of waiters) waiter.settle(now < waiter.deadline ? prepared : { kind: "late" });
	}

	async #loop(): Promise<void> {
		this.#running = true;
		try {
			while (this.#waiters.size > 0) {
				const attempt = await this.#attempt();
				if (attempt.kind === "ready") {
					this.#current = attempt.connection;
					this.#deliver({ kind: "ready", connection: attempt.connection }, attempt.at);
				} else if (attempt.kind === "refused") {
					this.#deliver({ kind: "refused", code: attempt.code }, attempt.at);
				} else if (attempt.kind === "unsafe") {
					this.#deliver({ kind: "unsafe" });
				} else if (attempt.kind === "absent" || attempt.kind === "dropped") {
					const now = this.clock.nowNs();
					if (this.#lastLaunch === undefined || now - this.#lastLaunch >= msToNs(RELAUNCH_MS)) {
						this.#lastLaunch = now;
						try {
							this.connector.launch();
						} catch {
							// A command that cannot be launched leaves the waiters to their connect deadline.
						}
					}
					if (this.#waiters.size > 0) await this.#sleep(now + msToNs(RECONNECT_MS));
				}
			}
		} finally {
			this.#running = false;
		}
	}

	/** Waits until the clock reads `until`, or until no waiter is left. */
	#sleep(until: bigint): Promise<void> {
		return new Promise((resolve) => {
			let timer: HopTimer | undefined;
			const done = (): void => {
				this.#wake = undefined;
				timer?.cancel();
				resolve();
			};
			this.#wake = done;
			timer = atMoment(this.clock, until, done);
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
				link.close();
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
					finish({ kind: "ready", connection, at: this.clock.nowNs() });
				} else if (message?.type === "refused") {
					drop({ kind: "refused", code: message.code, at: this.clock.nowNs() });
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
			link.hold(true);
			if (!link.write(writeHello(this.key))) finish({ kind: "dropped" });
		});
	}
}
