/**
 * The channel on a machine (CONTRACT.md, PX1, PX4): a Unix domain socket carrying newline-delimited JSON in
 * UTF-8, one message per line, each line at most 16785408 bytes with its newline.
 *
 * A line that is longer, is not UTF-8, or does not parse as JSON closes the connection, and nothing read
 * after it is delivered; whether a parsed message fits the channel's table is the half's to judge, and a
 * half that finds it does not closes the connection too. A link reports its closing once, whichever side
 * closed it. Nothing here listens on the network: the socket is a path in the runtime directory, reached
 * only as the host's own access rules on it allow.
 *
 * On the proxy's side a link keeps at most `maxUnwrittenBytes` unwritten - what it handed the socket that the
 * operating system has not yet taken - and a message whose writing would exceed that is not written: the
 * connection is closed at once, what it held unwritten discarded (PX6). What the operating system had already
 * taken still reaches the other side.
 */
import net from "node:net";
import type { ChannelLink, LinkHandlers } from "./channel-link.js";
import { CHANNEL_LIMITS, type ChannelMessage } from "./channel-messages.js";
import type { ConnectOutcome } from "./client-preparing.js";

const NEWLINE = 0x0a;

/** What a link over a socket keeps to. */
export interface SocketLinkOptions {
	/** The most it keeps unwritten; a write that would exceed it closes the connection at once (PX6). */
	readonly maxUnwrittenBytes?: number;
}

/** A link over a connected socket, its messages and its closing reported to the handlers. */
export function socketLink(socket: net.Socket, handlers: LinkHandlers, options: SocketLinkOptions = {}): ChannelLink {
	const maxUnwritten = options.maxUnwrittenBytes;
	let reported = false;
	let reading = true;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const decoder = new TextDecoder("utf-8", { fatal: true });

	const report = (): void => {
		if (reported) return;
		reported = true;
		reading = false;
		handlers.closed();
	};
	/** A line broke the framing: the connection is closed at once, and nothing more is read. */
	const broken = (): void => {
		reading = false;
		socket.destroy();
	};

	socket.on("data", (chunk: Buffer) => {
		let start = 0;
		while (reading) {
			const newline = chunk.indexOf(NEWLINE, start);
			if (newline < 0) break;
			const piece = chunk.subarray(start, newline);
			start = newline + 1;
			if (pendingBytes + piece.length + 1 > CHANNEL_LIMITS.lineBytes) return broken();
			const line = pendingBytes === 0 ? piece : Buffer.concat([...pending, piece], pendingBytes + piece.length);
			pending = [];
			pendingBytes = 0;
			let value: unknown;
			try {
				value = JSON.parse(decoder.decode(line));
			} catch {
				return broken();
			}
			handlers.message(value);
		}
		if (!reading || start >= chunk.length) return;
		const rest = chunk.subarray(start);
		// A line already longer than the limit allows, its newline still to come, can never fit.
		if (pendingBytes + rest.length + 1 > CHANNEL_LIMITS.lineBytes) return broken();
		pending.push(rest);
		pendingBytes += rest.length;
	});
	socket.on("error", () => undefined);
	socket.on("close", report);

	return Object.freeze({
		write(message: ChannelMessage): boolean {
			if (reported || socket.destroyed || !socket.writable) return false;
			const line = `${JSON.stringify(message)}\n`;
			if (maxUnwritten !== undefined && socket.writableLength + Buffer.byteLength(line, "utf8") > maxUnwritten) {
				// Not written: the connection is closed at once, what it held unwritten discarded (PX6).
				reading = false;
				socket.destroy();
				return false;
			}
			socket.write(line);
			return true;
		},
		close(): void {
			reading = false;
			if (socket.destroyed) return;
			// What was written is handed on first; then the connection is closed.
			socket.end(() => socket.destroy());
		},
		hold(keep: boolean): void {
			if (keep) socket.ref();
			else socket.unref();
		},
	});
}

/** Connects to a channel socket: a link once connected, or `absent` when nothing listens there. */
export function connectChannel(socketPath: string, handlers: LinkHandlers): Promise<ConnectOutcome> {
	return new Promise((resolve) => {
		const socket = net.createConnection({ path: socketPath });
		const failed = (): void => {
			socket.destroy();
			resolve({ kind: "absent" });
		};
		socket.once("error", failed);
		socket.once("connect", () => {
			socket.removeListener("error", failed);
			resolve({ kind: "connected", link: socketLink(socket, handlers) });
		});
	});
}

/** Listens on a channel socket path; each connection is given to `connection` as a socket. */
export function listenChannel(socketPath: string, connection: (socket: net.Socket) => void): Promise<net.Server> {
	return new Promise((resolve, reject) => {
		const server = net.createServer({ allowHalfOpen: false }, connection);
		server.once("error", reject);
		server.listen({ path: socketPath, exclusive: true }, () => {
			server.removeListener("error", reject);
			resolve(server);
		});
	});
}
