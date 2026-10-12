/**
 * One connection of the channel, as both halves see it (CONTRACT.md, PX1, PX4): messages written and read
 * as objects, whatever carries them. On a machine the adapter carries them as newline-delimited JSON over a
 * Unix domain socket, and closes the connection itself on a line that is too long or does not parse; in a
 * browser (PX8, declared and not built) a message port would carry them as objects. Nothing here is
 * particular to one runtime.
 */
import type { ChannelMessage } from "./channel-messages.js";

/** What a link tells the half that holds it. */
export interface LinkHandlers {
	/** One message read, parsed but not yet checked against the channel's table. */
	message(value: unknown): void;
	/** The connection closed - by either side, or because a line broke the framing - and nothing more comes. */
	closed(): void;
}

/** One open connection of the channel. */
export interface ChannelLink {
	/**
	 * Writes one message. True when it was handed to the connection, after which any byte of it may have
	 * reached the other side; false when the connection was already closed, and nothing of it was written.
	 */
	write(message: ChannelMessage): boolean;
	/** Closes the connection, once what was written has been handed on; the `closed` handler then runs. */
	close(): void;
	/**
	 * Whether this connection should keep its process running: the client half holds it while an invocation
	 * written on it waits for its ending, and lets it go otherwise, so an idle connection never keeps a
	 * short-lived process from ending.
	 */
	hold(keep: boolean): void;
}
