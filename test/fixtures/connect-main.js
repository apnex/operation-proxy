// connect-main - a raw client of a channel: `node connect-main.js <socket> <ack-dir> <key.json>`. It connects,
// and once the operating system reports the connection made - accepted by the kernel into the listener's queue,
// whether or not the listening process has taken it yet - writes `<ack-dir>/connected`; it sends `hello` with
// the key, writes every line it reads to `<ack-dir>/lines.json`, renamed into place whole, and ends once
// `<ack-dir>/close` exists, writing `<ack-dir>/closed` when its connection has closed. Its standard streams are
// ignored; it acknowledges only through files (CONTRACT.md, PX7).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const [socketPath, ackDir, keyJson] = process.argv.slice(2);
const write = (name, value) => {
	const temporary = path.join(ackDir, `${name}.${process.pid}.tmp`);
	fs.writeFileSync(temporary, JSON.stringify(value));
	fs.renameSync(temporary, path.join(ackDir, name));
};
const lines = [];
let rest = "";
const socket = net.createConnection({ path: socketPath });
socket.setEncoding("utf8");
socket.on("error", () => undefined);
socket.on("connect", () => {
	write("connected", { pid: process.pid });
	socket.write(`${JSON.stringify({ operationProxy: 1, type: "hello", key: JSON.parse(keyJson) })}\n`);
});
socket.on("data", (text) => {
	rest += text;
	let i;
	while ((i = rest.indexOf("\n")) >= 0) {
		lines.push(JSON.parse(rest.slice(0, i)));
		rest = rest.slice(i + 1);
	}
	write("lines.json", lines);
});
socket.on("close", () => {
	write("closed", { lines });
	clearInterval(poll);
});
const poll = setInterval(() => {
	if (fs.existsSync(path.join(ackDir, "close"))) socket.end();
}, 20);
