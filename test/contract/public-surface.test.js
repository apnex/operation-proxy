// public-surface - the package exposes exactly what export-map.json names (zorg's target, EM14; E12).
//
// Every path in package.json's exports is named in the map; each module path is imported by its public name
// and its runtime exports compared with the map; every capability row of CONTRACT.md is served by some export,
// none is deferred: zorg's Delta 1 and Delta 3 (D57) build all six rows and both the machine and browser adapters. The client half and the proxy half run in clients - a short-lived process, a browser's
// shared worker - so no source file imports a module particular to one runtime, or uses a global particular to
// Node, outside a file whose name ends -adapter.ts (zorg's principle 6, D31); AGP reaches the source as types
// only; and only the machine's clock adapter and its runtime adapter read a clock or randomness. Needs no socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const map = JSON.parse(fs.readFileSync(path.join(root, "export-map.json"), "utf8"));
const publicName = (p) => p === "." ? pkg.name : `${pkg.name}/${p.slice(2)}`;
const FENCED = ["proxied-invocation", "caller-interface-parity", "proxy-on-demand", "proxy-idle-expiry", "one-identity-per-proxy", "host-local-proxy-channel"];

test("the export map names the package and exactly its exported paths", () => {
	assert.equal(map.package, pkg.name);
	assert.deepEqual(Object.keys(map.paths).sort(), Object.keys(pkg.exports).sort());
	assert.deepEqual(Object.keys(map).sort(), ["deferred", "package", "paths"]);
});

for (const [p, entry] of Object.entries(map.paths)) {
	test(`${publicName(p)} exposes exactly what the map names`, async () => {
		assert.ok(entry.exports, `${p} names no exports`);
		const mod = await import(publicName(p));
		assert.deepEqual(Object.keys(mod).sort(), Object.keys(entry.exports).sort());
		for (const [name, use] of Object.entries(entry.exports)) {
			assert.equal(use.part, "operation-proxy", `${name} realises the operation-proxy part`);
			assert.ok(Array.isArray(use.serves) && use.serves.length > 0, `${name} serves at least one row`);
		}
	});
}

const contractRows = () => {
	const lines = fs.readFileSync(path.join(root, "CONTRACT.md"), "utf8").split("\n");
	const start = lines.findIndex((l) => /^\|\s*Capability\s*\|\s*Relation\s*\|/.test(l));
	const rows = [];
	for (let i = start + 2; start >= 0 && lines[i]?.startsWith("|"); i++) rows.push(lines[i].split("|")[1].trim().replaceAll("`", ""));
	return rows;
};

test("every contract row is served by an export and none deferred; both the machine and browser adapters are built (D57)", () => {
	const rows = contractRows();
	assert.deepEqual(rows, FENCED, "the six rows zorg's Delta 1 fences, as CONTRACT.md lists them");
	const served = new Set(Object.values(map.paths).flatMap((e) => Object.values(e.exports)).flatMap((x) => x.serves));
	for (const row of rows) assert.ok(served.has(row), `${row} is served`);
	for (const row of served) assert.ok(rows.includes(row), `${row} is not a row of CONTRACT.md`);
	assert.deepEqual(map.deferred, {}, "no deferred entry remains in Delta 3 (zorg's D57)");
	assert.match(fs.readFileSync(path.join(root, "CONTRACT.md"), "utf8"), /\*\*PX8 - The browser adapter \(`D57`\)\.\*\*/);
	assert.ok(fs.existsSync(path.join(root, "test", "contract", "browser-adapter.test.js")), "browser-adapter.test.js");
});

test("every fenced row has a contract test file named for it", () => {
	for (const row of FENCED) assert.ok(fs.existsSync(path.join(root, "test", "contract", `${row}.test.js`)), `${row}.test.js`);
});

const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? sources(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const tsSources = () => sources(path.join(root, "src")).filter((f) => f.endsWith(".ts"));
const imports = (text) => [...text.matchAll(/\bimport\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bexport\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g)]
	.map((m) => ({ typeOnly: Boolean(m[1] || m[4]), specifier: m[2] ?? m[3] ?? m[5] ?? m[6] }));
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const ADAPTERS = ["browser-adapter.ts", "machine-adapter.ts", "machine-channel-adapter.ts", "machine-clock-adapter.ts", "machine-runtime-adapter.ts"];

test("no source file imports a module particular to one runtime outside a file whose name ends -adapter.ts, or uses a global particular to Node", () => {
	const files = tsSources();
	assert.ok(files.length > 10);
	assert.deepEqual(files.map((f) => path.basename(f)).filter((n) => n.endsWith("-adapter.ts")).sort(), ADAPTERS);
	for (const file of files) {
		if (file.endsWith("-adapter.ts")) continue;
		const text = fs.readFileSync(file, "utf8");
		const runtime = imports(text).map((i) => i.specifier).filter((s) => s.startsWith("node:") || builtins.has(s));
		assert.deepEqual(runtime, [], `${path.relative(root, file)} imports ${runtime.join(", ")}`);
		assert.doesNotMatch(code(text), /\b(process|Buffer|__dirname|__filename|setImmediate|setTimeout|setInterval)\b|\brequire\s*\(/, `${path.relative(root, file)} uses a global particular to Node or a timer of its own`);
		const machine = imports(text).map((i) => i.specifier).filter((s) => /-adapter\.js$/.test(s));
		if (!["machine.ts", "browser.ts"].includes(path.basename(file))) assert.deepEqual(machine, [], `${path.relative(root, file)} reaches an adapter`);
	}
});

test("AGP reaches the source as types only", () => {
	for (const file of tsSources()) {
		for (const { typeOnly, specifier } of imports(fs.readFileSync(file, "utf8"))) {
			if (specifier.startsWith("@agp/")) assert.ok(typeOnly, `${path.relative(root, file)} imports ${specifier} at run time`);
		}
	}
});

test("only the machine's clock and runtime adapters read a clock or randomness; the halves take them through ports", () => {
	for (const file of tsSources()) {
		const text = code(fs.readFileSync(file, "utf8"));
		const reads = /Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now|hrtime|Temporal\.Now|Math\.random|getRandomValues|randomBytes/.test(text);
		const allowed = ["browser-adapter.ts", "machine-clock-adapter.ts", "machine-runtime-adapter.ts"].includes(path.basename(file));
		if (!allowed) assert.equal(reads, false, `${path.relative(root, file)} reads a clock or randomness`);
	}
});

const validDepSpec = (name, spec) => spec === `file:../${name}` || new RegExp(`^https://github\\.com/apnex/${name}/releases/download/v0\\.\\d+\\.\\d+/apnex-${name}-0\\.\\d+\\.\\d+\\.tgz$`).test(spec);

test("the package depends on operation-call and shape-check through file: links or pinned GitHub release URLs, and on nothing else at run time", () => {
	assert.deepEqual(Object.keys(pkg.dependencies ?? {}).sort(), ["@apnex/operation-call", "@apnex/shape-check"]);
	assert.ok(validDepSpec("operation-call", pkg.dependencies["@apnex/operation-call"]));
	assert.ok(validDepSpec("shape-check", pkg.dependencies["@apnex/shape-check"]));
	for (const [name, spec] of Object.entries(pkg.devDependencies)) {
		if (name.startsWith("@agp/")) assert.match(spec, /^file:\.\.\//, `${name} is linked from a checkout beside this one`);
		else if (name.startsWith("@apnex/")) assert.ok(validDepSpec(name.slice(7), spec), `${name} is linked from a checkout or pinned release`);
	}
});
