// caller-interface-parity - the client half offers the caller interface the call layer offers, so code written
// against the call layer runs through the proxy unchanged (CONTRACT.md, PX10; zorg's E17).
//
// operation-call's exported caller suite (@apnex/operation-call/caller-suite, at 2e435a8 or later) runs against
// the client half, with the proxy half in the same process over a real channel socket and AGP's production
// in-process carrier, the hop intact, its allowance stated: every case, none excluded, each judged by PX5's
// rule. Needs Unix sockets; spawns no child process.
//
// The same parity holds for the types (zorg's target, EM12): test/types/caller-interface-parity.ts, a strict
// TypeScript function accepting operation-call's OperationCaller given operation-call's caller and the client
// half unchanged, is compiled by `npm test` before these tests run, and npm test fails when it does not compile.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { callerSuiteRows, registerCallerSuite } from "@apnex/operation-call/caller-suite";
import { parityHarness } from "../support/parity-harness.js";

const harness = parityHarness({ allowanceMs: 50 });
const names = [];
const registered = registerCallerSuite((name, run) => {
	names.push(name);
	return test(`through the client half, an allowance of 50 ms: ${name}`, { timeout: 120_000 }, run);
}, harness);

test("the harness states the client half's hop allowance, the application default of 50 ms (PX5, PX9)", () => {
	assert.equal(harness.hopAllowanceMs, 50);
});

test("every case of every row of the caller suite is registered through the client half, none excluded", () => {
	const all = [];
	registerCallerSuite((name) => { all.push(name); }, { hopAllowanceMs: 0, open: () => assert.fail("not opened") });
	assert.deepEqual(names, all);
	assert.equal(registered, all.length);
	assert.ok(registered >= 58, `the suite holds ${registered} cases`);
	for (const row of callerSuiteRows.rows) assert.ok(names.some((n) => n.startsWith(`${row}: `)), `row ${row} runs`);
});

test("a strict TypeScript consumer accepting OperationCaller, given operation-call's caller and the client half unchanged, is compiled by npm test (EM12)", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	assert.equal(pkg.scripts["test:types"], "tsc -p test/types");
	assert.match(pkg.scripts.test, /^npm run build && npm run test:types && node --test /);
	const config = JSON.parse(fs.readFileSync(path.join(root, "test", "types", "tsconfig.json"), "utf8"));
	assert.equal(config.extends, "../../tsconfig.json", "the package's own strict settings");
	assert.equal(config.compilerOptions.noEmit, true);
	const source = fs.readFileSync(path.join(root, "test", "types", "caller-interface-parity.ts"), "utf8");
	assert.match(source, /async function describe\(caller: OperationCaller, call: CallRequest\)/);
	for (const given of ["describe(await createCaller(options), call)", "describe(createProxyClient(options), call)", "describe(createMachineClient(application), call)"]) assert.ok(source.includes(given), given);
	assert.doesNotMatch(source, / as (OperationCaller|CallEnding|unknown)\b/, "no cast");
});
