/**
 * Where a proxy is found on a machine (CONTRACT.md, PX2), for Linux.
 *
 * The runtime directory is `.operation-proxy` in the user's home directory as the system's user database
 * records it - `os.userInfo()`, never `HOME` or any other environment variable - so every process of the
 * user on the host agrees on it. It is created with mode 0700 when absent, and refused when it is not a
 * directory, is not owned by the user, or grants any permission to the group or to others. In it, the file
 * `secret` holds 32 random lowercase hexadecimal digits and a newline: a process finding none writes a
 * complete one, mode 0600, to `secret.<16 random hexadecimal digits>`, links that file to `secret` - which
 * succeeds for one process only - and removes its own, so `secret` only ever appears whole; every process
 * then reads `secret`, refusing one that is not exactly 33 bytes of that form. A key's channel is the socket
 * `<runtime directory>/<digest>.sock`, refused when its path would be longer than 107 bytes, and its
 * ownership the abstract-namespace socket `operation-proxy-<secret>-<digest>`.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Why a runtime directory, its secret or a channel's path was refused (PX2). */
export type UnsafeReason = "not-a-directory" | "not-owned" | "open-to-others" | "unusable" | "secret-malformed" | "path-too-long";

/** A refusal of the runtime directory: the invocation ends `not-delivered` with `runtime-dir-unsafe`. */
export class RuntimeUnsafe extends Error {
	constructor(readonly reason: UnsafeReason, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RuntimeUnsafe";
	}
}

/** The runtime directory's name in the user's home directory. */
export const RUNTIME_DIRECTORY_NAME = ".operation-proxy";
/** The longest channel socket path, in bytes. */
export const SOCKET_PATH_MAX_BYTES = 107;
/** The form of the secret's 33 bytes. */
const SECRET_FORM = /^[0-9a-f]{32}\n$/;

/** The runtime directory: in the user's home directory as the user database records it (PX2). */
export function runtimeDirectory(): string {
	return path.join(os.userInfo().homedir, RUNTIME_DIRECTORY_NAME);
}

/** Moments in writing a secret, observed by tests that kill a process at each. */
export interface SecretStages {
	/** The complete secret is in the process's own file, not yet linked. */
	readonly written?: (ownFile: string) => void;
	/** The process's link to `secret` was made or found taken, and its own file is not yet removed. */
	readonly linked?: (ownFile: string) => void;
}

/** The error code of a failed system call, if it has one. */
function codeOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** Creates the runtime directory when absent, and refuses one PX2 does not allow. */
export function ensureDirectory(dir: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(dir);
	} catch (error) {
		if (codeOf(error) !== "ENOENT") throw new RuntimeUnsafe("unusable", `the runtime directory ${dir} cannot be examined`, { cause: error });
		try {
			fs.mkdirSync(dir, { mode: 0o700 });
			// Created by this process: exactly 0700, whatever the process's umask removed.
			fs.chmodSync(dir, 0o700);
		} catch (made) {
			if (codeOf(made) !== "EEXIST") throw new RuntimeUnsafe("unusable", `the runtime directory ${dir} cannot be created`, { cause: made });
		}
		try {
			stat = fs.lstatSync(dir);
		} catch (again) {
			throw new RuntimeUnsafe("unusable", `the runtime directory ${dir} cannot be examined`, { cause: again });
		}
	}
	if (!stat.isDirectory()) throw new RuntimeUnsafe("not-a-directory", `the runtime directory ${dir} is not a directory`);
	if (stat.uid !== process.getuid?.()) throw new RuntimeUnsafe("not-owned", `the runtime directory ${dir} is not owned by this user`);
	if ((stat.mode & 0o077) !== 0) throw new RuntimeUnsafe("open-to-others", `the runtime directory ${dir} grants permissions to its group or to others`);
}

/** Writes a complete secret to the process's own file and links it to `secret`; one process's link wins. */
function writeSecret(dir: string, stages: SecretStages): void {
	const own = path.join(dir, `secret.${randomBytes(8).toString("hex")}`);
	const secret = `${randomBytes(16).toString("hex")}\n`;
	try {
		const fd = fs.openSync(own, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.fchmodSync(fd, 0o600);
			fs.writeSync(fd, secret);
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch (error) {
		throw new RuntimeUnsafe("unusable", `a secret cannot be written in ${dir}`, { cause: error });
	}
	stages.written?.(own);
	try {
		fs.linkSync(own, path.join(dir, "secret"));
	} catch (error) {
		// Another process linked its secret first: that one is the secret, and this file is removed.
		if (codeOf(error) !== "EEXIST") {
			fs.rmSync(own, { force: true });
			throw new RuntimeUnsafe("unusable", `a secret cannot be linked in ${dir}`, { cause: error });
		}
	}
	stages.linked?.(own);
	fs.rmSync(own, { force: true });
}

/** Reads `secret`: its 32 hexadecimal digits, or undefined when there is none yet. */
function readSecret(dir: string): string | undefined {
	const file = path.join(dir, "secret");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(file);
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw new RuntimeUnsafe("unusable", `the secret in ${dir} cannot be examined`, { cause: error });
	}
	// Only a regular file can hold the 33 bytes; anything else, which reading could block on, is refused.
	if (!stat.isFile()) throw new RuntimeUnsafe("secret-malformed", `the secret in ${dir} is not a file`);
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch (error) {
		throw new RuntimeUnsafe("unusable", `the secret in ${dir} cannot be read`, { cause: error });
	}
	const text = bytes.toString("latin1");
	if (bytes.length !== 33 || !SECRET_FORM.test(text)) throw new RuntimeUnsafe("secret-malformed", `the secret in ${dir} is not 32 lowercase hexadecimal digits and a newline`);
	return text.slice(0, 32);
}

/**
 * Makes the runtime directory ready and gives the secret's 32 hexadecimal digits (PX2): the directory created
 * or checked, and a secret written and linked when there is none.
 */
export function ensureRuntime(dir: string, stages: SecretStages = {}): string {
	ensureDirectory(dir);
	const found = readSecret(dir);
	if (found !== undefined) return found;
	writeSecret(dir, stages);
	const secret = readSecret(dir);
	if (secret === undefined) throw new RuntimeUnsafe("unusable", `the secret in ${dir} vanished after it was linked`);
	return secret;
}

/** A key's channel socket path, refused when it would be longer than 107 bytes (PX2). */
export function channelPath(dir: string, digest: string): string {
	const socket = path.join(dir, `${digest}.sock`);
	if (Buffer.byteLength(socket, "utf8") > SOCKET_PATH_MAX_BYTES) throw new RuntimeUnsafe("path-too-long", `the channel socket path ${socket} is longer than ${SOCKET_PATH_MAX_BYTES} bytes`);
	return socket;
}

/** A key's ownership socket, in the abstract namespace: `operation-proxy-<secret>-<digest>` (PX2, PX3). */
export function ownershipName(secret: string, digest: string): string {
	return `\0operation-proxy-${secret}-${digest}`;
}
