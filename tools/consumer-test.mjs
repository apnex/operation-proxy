#!/usr/bin/env node
// consumer-test - the package as a consumer receives it (docs/DECISIONS.md, the first release).
//
// It packs the package -- or takes a tarball already packed, such as the one a release attaches -- installs
// the file into an empty project with --omit=dev, finds no AGP package installed, so a consumer that does
// not run AGP installs none of it, and imports every export of every path export-map.json names, by name,
// in Node; a data path is read as JSON.
// The paths the contract says run in a browser are loaded in headless Chrome too, through an import map of the
// installed packages, with headless-chromium's serveStatic and dumpDom.
//
// Usage:  node tools/consumer-test.mjs [--tarball FILE]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const map = JSON.parse(fs.readFileSync(path.join(root, "export-map.json"), "utf8"));
const at = process.argv.indexOf("--tarball");
const given = at > -1 ? path.resolve(process.argv[at + 1]) : null;
/** The paths the contract says run in a browser, each loaded in headless Chrome as well; none for most. */
const BROWSER_PATHS = [".", "./browser"];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "consumer-"));
const step = (message) => console.log(`  ${message}`);
const fail = (message) => {
	throw new Error(message);
};
const specifierOf = (pkg, p) => (p === "." ? pkg : `${pkg}/${p.slice(2)}`);

async function main() {
	// 1. the tarball given, or build and pack one, as a release does
	let tarball;
	if (given) {
		if (!fs.existsSync(given)) fail(`no tarball at ${given}`);
		tarball = given;
		step(`took the tarball given, ${path.basename(tarball)}`);
	} else {
		execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
		const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }));
		tarball = path.join(scratch, packed[0].filename);
		step(`packed ${packed[0].filename}: ${packed[0].files.length} files`);
	}

	// 2. installed into an empty project, without development dependencies
	const project = path.join(scratch, "project");
	fs.mkdirSync(project);
	fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "consumer", version: "0.0.0", private: true, type: "module" }, null, 2));
	execFileSync("npm", ["install", tarball, "--omit=dev", "--no-audit", "--no-fund"], { cwd: project, stdio: ["ignore", "ignore", "inherit"] });
	const lock = JSON.parse(fs.readFileSync(path.join(project, "package-lock.json"), "utf8"));
	const installed = Object.keys(lock.packages).filter((k) => k !== "").map((k) => k.replace(/^.*node_modules\//, ""));
	const agp = installed.filter((name) => name.startsWith("@agp/"));
	if (agp.length > 0 || fs.existsSync(path.join(project, "node_modules", "@agp"))) fail(`installing brought AGP: ${agp.join(", ")}`);
	step(`installed ${map.package} into an empty project with --omit=dev: ${installed.join(", ")}; no AGP package`);

	// 3. every export of every path, imported by name in Node; a data path read as JSON
	const lines = [];
	let index = 0;
	for (const [p, entry] of Object.entries(map.paths)) {
		const specifier = specifierOf(map.package, p);
		if (entry.exports) {
			const names = Object.keys(entry.exports);
			lines.push(`import { ${names.join(", ")} } from ${JSON.stringify(specifier)};`);
			lines.push(`for (const [name, value] of Object.entries({ ${names.join(", ")} })) if (value === undefined) throw new Error(${JSON.stringify(specifier)} + ": " + name + " is undefined");`);
		} else {
			lines.push(`import data${index} from ${JSON.stringify(specifier)} with { type: "json" };`);
			lines.push(`if (!data${index} || typeof data${index} !== "object") throw new Error(${JSON.stringify(specifier)} + " holds no data");`);
			index++;
		}
	}
	lines.push(`console.log("node-ok");`);
	fs.writeFileSync(path.join(project, "node-check.mjs"), lines.join("\n") + "\n");
	const out = execFileSync(process.execPath, ["node-check.mjs"], { cwd: project, encoding: "utf8" });
	if (out.trim() !== "node-ok") fail(`Node: ${out}`);
	step(`Node ${process.version} imported every export of ${Object.keys(map.paths).map((p) => specifierOf(map.package, p)).join(", ")} by name`);

	// 4. the paths the contract says run in a browser, loaded in headless Chrome through an import map
	if (BROWSER_PATHS.length > 0) await inChrome(project);
}

/** Serves the installed packages and loads the browser paths' exports in a one-shot headless Chrome. */
async function inChrome(project) {
	const { dumpDom, findChrome, serveStatic } = await import("@apnex/headless-chromium");
	if (findChrome() === null) fail("no Chrome: set CHROME, or put google-chrome on PATH");
	const scope = path.join(project, "node_modules", "@apnex");
	const imports = {};
	const folders = {};
	for (const dir of fs.readdirSync(scope)) {
		const installed = path.join(scope, dir);
		const pkg = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
		const base = `/vendor/${pkg.name}@${pkg.version}/`;
		folders[base] = installed;
		for (const [p, target] of Object.entries(pkg.exports ?? {})) {
			const file = typeof target === "string" ? target : target.default;
			if (typeof file === "string" && file.endsWith(".js")) imports[specifierOf(pkg.name, p)] = base + file.slice(2);
		}
	}
	const wanted = BROWSER_PATHS.map((p) => [specifierOf(map.package, p), Object.keys(map.paths[p].exports)]);
	const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>consumer</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
const out = document.getElementById("result");
try {
	const missing = [];
	for (const [specifier, names] of ${JSON.stringify(wanted)}) {
		const mod = await import(specifier);
		for (const name of names) if (mod[name] === undefined) missing.push(specifier + ":" + name);
	}
	out.textContent = missing.length === 0 ? "browser-ok" : "browser-missing " + missing.join(",");
} catch (e) {
	out.textContent = "browser-error " + e.message;
}
</script></head><body><pre id="result">browser-pending</pre></body></html>
`;
	const server = await serveStatic({ pages: { "/": page }, folders });
	try {
		const dom = await dumpDom(`${server.origin}/`, { virtualTimeBudgetMs: 10000, timeoutMs: 90000 });
		const result = dom.match(/<pre id="result">([^<]*)<\/pre>/)?.[1] ?? "";
		const missed = server.requests.filter((r) => r.status !== 200 && r.path !== "/favicon.ico");
		if (missed.length) fail(`requests not answered 200: ${missed.map((r) => `${r.path} ${r.status}`).join(", ")}`);
		if (result !== "browser-ok") fail(`Chrome's page says: ${result || dom.slice(0, 400)}`);
		step(`headless Chrome imported every export of ${wanted.map(([s]) => s).join(" and ")} through an import map: ${server.requests.length} requests, each answered 200`);
	} finally {
		await server.close();
	}
}

try {
	await main();
	console.log("consumer-test: PASS");
} catch (e) {
	console.log(`consumer-test: FAIL -- ${e.message}`);
	process.exitCode = 1;
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
