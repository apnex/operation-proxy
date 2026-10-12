// client-main - a short-lived process of the fixture application: `node client-main.js <config.json>
// <ack-file> <call.json>`. It builds the client half, prepares it within the call's `connectMs` (by default
// zorg's connect timeout of 5 seconds) unless `connectMs` is null, and then, unless the call is `prepareOnly`
// or preparing ended it, invokes the call - and acknowledges by writing the ending, with its own process id, to the ack file, renamed into
// place whole, which the test polls; then it exits. Its proxy is launched as `proxy-main.js` with the same
// configuration, the call's `idleMs` given on the command line when it holds one (PX9).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMachineClient } from "@apnex/operation-proxy/machine";
import { createMachineClientIn } from "../../dist/machine-adapter.js";

const [configFile, ackFile, callFile] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const call = JSON.parse(fs.readFileSync(callFile, "utf8"));
const proxyMain = path.join(path.dirname(fileURLToPath(import.meta.url)), "proxy-main.js");
const args = [proxyMain, configFile, ...(call.idleMs === undefined ? [] : ["--idle-ms", String(call.idleMs)])];
const application = { key: config.key, launch: { command: process.execPath, args }, hopAllowanceMs: config.hopAllowanceMs };
const client = config.realHome ? createMachineClient(application) : createMachineClientIn(config.runtimeDir, application);
const ack = (value) => {
	const temporary = `${ackFile}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, ...value }));
	fs.renameSync(temporary, ackFile);
};
if (call.startedFile) fs.writeFileSync(call.startedFile, String(process.pid));
const started = performance.now();
const prepared = call.connectMs === null ? "ready" : await client.prepare({ timeMs: call.connectMs ?? 5000 });
const preparedMs = performance.now() - started;
if (call.writtenFile) fs.writeFileSync(call.writtenFile, String(process.pid));
const ending = prepared !== "ready" || call.prepareOnly ? prepared
	: await client.invoke({ host: "host-a", service: call.service ?? "fixture", operation: call.operation, input: call.input ?? {}, bound: call.bound ?? 5000 });
ack({ ending, preparedMs, elapsedMs: performance.now() - started });
client.close();
process.exit(0);
