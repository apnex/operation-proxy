// contract-coverage - one entry per row of CONTRACT.md, so the contract reads as a list of tests.
//
// A row whose test file exists beside this one is covered by that file; every other row is reported
// as a to-do, which passes but stays visible until the capability is built and tested. An adapter the
// export map defers - the browser adapter of PX8, declared and not built - is reported as a to-do too,
// naming the test owed with it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const lines = fs.readFileSync(path.join(here, "..", "..", "CONTRACT.md"), "utf8").split("\n");
const start = lines.findIndex((line) => /^\|\s*Capability\s*\|\s*Relation\s*\|/.test(line));
const rows = [];
for (let i = start + 2; start >= 0 && i < lines.length && lines[i].startsWith("|"); i++) {
	const cells = lines[i].split("|").slice(1, -1).map((cell) => cell.trim());
	rows.push({ capability: cells[0].replaceAll("`", ""), relation: cells[1] });
}

test("CONTRACT.md has a capability table with at least one row", () => {
	assert.ok(start >= 0, "CONTRACT.md has no capability table");
	assert.ok(rows.length > 0, "CONTRACT.md lists no capabilities");
});

for (const row of rows) {
	if (fs.existsSync(path.join(here, `${row.capability}.test.js`))) continue;
	test.todo(`${row.capability} (${row.relation}) has no contract test yet`);
}

const map = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "export-map.json"), "utf8"));
for (const [deferred, ruling] of Object.entries(map.deferred ?? {})) {
	if (rows.some((row) => row.capability === deferred)) continue;
	test.todo(`${deferred} (deferred, ${ruling}) is declared and not built; its test/contract/${deferred}.test.js is owed with it`);
}
