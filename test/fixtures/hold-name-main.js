// hold-name-main - a process that is no proxy holding an abstract-namespace name (CONTRACT.md, PX2, PX3):
// `node hold-name-main.js <name> <ack-dir>`. It listens on the abstract socket `<name>` - the name as
// /proc/net/unix lists it, without its leading `@` - and, once listening, writes `<ack-dir>/listening` with its
// process id. It speaks no protocol: a connection it is given is held silent, and the bytes it reads on it are
// counted in `<ack-dir>/received`, renamed into place whole. It holds the name until it is signalled. Its
// standard streams are ignored; it acknowledges only through files.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const [name, ackDir] = process.argv.slice(2);
const write = (file, value) => {
	const temporary = path.join(ackDir, `${file}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, path.join(ackDir, file));
};
let connections = 0;
let bytes = 0;
const server = net.createServer((socket) => {
	connections++;
	write("received", { connections, bytes });
	socket.on("error", () => undefined);
	socket.on("data", (chunk) => {
		bytes += chunk.length;
		write("received", { connections, bytes });
	});
});
server.on("error", (error) => {
	write("failed", { pid: process.pid, code: error.code ?? String(error) });
	process.exit(1);
});
server.listen({ path: `\0${name}` }, () => write("listening", { pid: process.pid }));
