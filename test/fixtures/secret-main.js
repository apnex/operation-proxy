// secret-main - one process making a runtime directory ready, as the client half does first (CONTRACT.md,
// PX2): `node secret-main.js <dir> <ack-file> [written|linked]`. It acknowledges the secret it read by writing
// it to the ack file, renamed into place whole. Given a stage, it acknowledges that stage instead and blocks
// its whole thread there, so a test can kill it exactly between writing its own file and linking it, or between
// linking and removing its own file. Given `pause-written`, it acknowledges having written its own file and
// stops itself with SIGSTOP there; continued, it links, reads and acknowledges the secret it read.
import fs from "node:fs";
import { ensureRuntime } from "../../dist/machine-runtime-adapter.js";
import { block } from "./fixture-app.js";

const [dir, ackFile, stage] = process.argv.slice(2);
const ack = (value) => {
	fs.writeFileSync(`${ackFile}.tmp`, JSON.stringify(value));
	fs.renameSync(`${ackFile}.tmp`, ackFile);
};
const stop = (at) => (ownFile) => {
	if (stage === `pause-${at}`) {
		ack({ stage: at, ownFile, pid: process.pid });
		process.kill(process.pid, "SIGSTOP");
		return;
	}
	if (stage !== at) return;
	ack({ stage: at, ownFile, pid: process.pid });
	block(60_000);
};
try {
	const secret = ensureRuntime(dir, { written: stop("written"), linked: stop("linked") });
	ack({ secret, pid: process.pid });
} catch (error) {
	ack({ error: error.reason ?? String(error), pid: process.pid });
}
