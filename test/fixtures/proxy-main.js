// proxy-main - the fixture application's launching command: `node proxy-main.js <config.json> [--idle-ms N]`,
// which runs this process as the key's proxy (CONTRACT.md, PX3, PX7, PX9). The idle time given on the command
// line prevails over the configuration's. Each stage of the proxy's life is recorded with the process's id in
// `<records>/stages.ndjson`; when the configuration names a stage in `blockAt`, the first process to reach it
// blocks its whole thread there for `blockMs`, so a test can kill it at exactly that step.
import fs from "node:fs";
import path from "node:path";
import { runMachineProxy } from "@apnex/operation-proxy/machine";
import { runProxyProcess, startMachineProxyIn } from "../../dist/machine-adapter.js";
import { block, fixtureProxyApplication, record } from "./fixture-app.js";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const idleAt = process.argv.indexOf("--idle-ms");
if (idleAt > 0) config.idleMs = Number(process.argv[idleAt + 1]);
const stages = path.join(config.records, "stages.ndjson");
record(stages, { pid: process.pid, stage: "started", idleMs: config.idleMs });
const observe = (stage) => {
	record(stages, { pid: process.pid, stage });
	if (config.blockAt !== stage) return;
	const once = path.join(config.records, "blocked");
	try {
		fs.writeFileSync(once, String(process.pid), { flag: "wx" });
	} catch {
		return;
	}
	record(stages, { pid: process.pid, stage: `blocked-at-${stage}` });
	block(config.blockMs ?? 60_000);
};
process.on("exit", (status) => record(stages, { pid: process.pid, stage: "exit", status }));
const application = fixtureProxyApplication(config);
if (config.realHome) await runMachineProxy(application, { observe });
else await runProxyProcess(() => startMachineProxyIn(config.runtimeDir, application, { observe }));
