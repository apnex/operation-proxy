// hold-name-main - a process that is no proxy holding a key's ownership lock (CONTRACT.md, PX2, PX3):
// `node hold-name-main.js <lockPath> <ack-dir>`. It acquires the exclusive kernel lock on `<lockPath>` via
// DatabaseSync and, once locked, writes `<ack-dir>/listening` with its process id. It holds the lock until it is
// signalled. Its standard streams are ignored; it acknowledges only through files.
import fs from "node:fs";
import path from "node:path";

const [lockPath, ackDir] = process.argv.slice(2);
const write = (file, value) => {
	const temporary = path.join(ackDir, `${file}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, path.join(ackDir, file));
};
const orig = process.emitWarning;
process.emitWarning = (w, ...args) => { if (String(w).includes("SQLite")) return; return orig.call(process, w, ...args); };
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = orig;
try {
	const db = new DatabaseSync(lockPath, { timeout: 0 });
	db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS own (x INT); INSERT INTO own VALUES (1);");
	write("listening", { pid: process.pid });
	setInterval(() => {}, 1000);
} catch (error) {
	write("failed", { pid: process.pid, code: error.code ?? String(error) });
	process.exit(1);
}
