// fixture-hosts - operation-call hosts on the topology's host nodes, serving fixture operations under one or
// more service names, each run recorded, so a test sees exactly what reached the operation's host.
//
// `echo` answers its input; `which` answers the host, the service and the identities it was given; `hold`
// waits until the test releases that run, then answers like `which`; `hold-refuses` waits, then refuses with
// the refusal record its input holds; `silent` never answers; `refuses` refuses with its input; `throws` throws.
//
// Operations answering in parts (zorg's EM11; Delta 4, stage 6): `stream` sends each answer of `input.parts` as a
// part, awaiting each, then answers `{sent, results}`; `quiet` sends no part and answers `{cancelled: true}` once
// its signal fires; `drip` sends a part each time the test releases a latch, `input.count` of them, then waits
// as `quiet` does; `flood` sends `input.n` parts of a string of `input.size` characters, awaiting each, and
// answers `{sent}`, stopping at the first that resolves false. Each run records whether, and when, its signal
// fired, so a test sees a cancel reach the host. The hosts keep time on the clock port given, the system's own
// when none is.
import { createOperationHost } from "@apnex/operation-call";

export const ANY = Object.freeze({ $schema: "urn:apnex:shape-check:dialect:1" });
export const OPERATIONS = ["echo", "which", "hold", "hold-refuses", "silent", "refuses", "throws"];
export const PARTS_OPERATIONS = ["stream", "quiet", "drip", "flood"];

/** A latch an operation waits on and a test releases. */
export function latch() {
	const { promise, resolve } = Promise.withResolvers();
	return { wait: promise, release: () => resolve() };
}

/** Opens fixture hosts under each service on a host node; gives its runs and the latches of its held runs. */
export async function openFixtureHost(host, services = ["fixture"], clock = undefined) {
	const runs = [];
	const holds = [];
	const opened = [];
	for (const service of services) {
		const opening = await createOperationHost(host.node, { service, ...(clock === undefined ? {} : { clock }) });
		if (!opening.opened) throw new Error(`the fixture host ${service} on ${host.nodeId} did not open`);
		opened.push(opening.host);
		const who = (c) => ({ host: host.nodeId, service, invocation: c.invocation, attempt: c.attempt });
		const handlers = {
			echo: (input) => ({ outcome: "answered", answer: input }),
			which: (_input, c) => ({ outcome: "answered", answer: who(c) }),
			hold: async (input, c) => {
				const held = latch();
				holds.push(held);
				await held.wait;
				return { outcome: "answered", answer: { ...who(c), input } };
			},
			"hold-refuses": async (input) => {
				const held = latch();
				holds.push(held);
				await held.wait;
				return { outcome: "refused", refusal: input };
			},
			silent: (_input, c) => new Promise((_resolve, reject) => c.signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
			refuses: (input) => ({ outcome: "refused", refusal: input }),
			throws: () => { throw new Error("the fixture operation failed"); },
		};
		const signalled = (c) => new Promise((resolve) => {
			if (c.signal.aborted) resolve();
			else c.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		const partsHandlers = {
			stream: async (input, c) => {
				const results = [];
				for (const answer of input.parts ?? []) results.push(await c.part(answer));
				return { outcome: "answered", answer: { sent: results.length, results } };
			},
			quiet: async (_input, c) => {
				await signalled(c);
				return { outcome: "answered", answer: { cancelled: true } };
			},
			drip: async (input, c) => {
				for (let i = 0; i < (input.count ?? 0); i++) {
					const held = latch();
					holds.push(held);
					await Promise.race([held.wait, signalled(c)]);
					if (c.signal.aborted) break;
					await c.part({ drip: i + 1 });
				}
				await signalled(c);
				return { outcome: "answered", answer: { cancelled: true } };
			},
			flood: async (input, c) => {
				const text = "x".repeat(input.size ?? 1);
				let sent = 0;
				for (let i = 0; i < (input.n ?? 0); i++) {
					if (!await c.part({ i, text })) break;
					sent++;
				}
				return { outcome: "answered", answer: { sent } };
			},
		};
		const recorded = (input, c) => {
			const run = { service, operation: c.operation, input, invocation: c.invocation, attempt: c.attempt, origin: c.delivery.source.originNodeId, aborted: c.signal.aborted };
			if (!run.aborted) c.signal.addEventListener("abort", () => { run.aborted = true; }, { once: true });
			runs.push(run);
		};
		for (const name of OPERATIONS) {
			const declared = await opening.host.declare({ name, input: ANY, answers: "whole" }, (input, c) => {
				recorded(input, c);
				return handlers[name](input, c);
			});
			if (!declared.declared) throw new Error(`${service}/${name} was not declared`);
		}
		for (const name of PARTS_OPERATIONS) {
			const declared = await opening.host.declare({ name, input: ANY, answers: "parts" }, (input, c) => {
				recorded(input, c);
				return partsHandlers[name](input, c);
			});
			if (!declared.declared) throw new Error(`${service}/${name} was not declared`);
		}
	}
	return {
		nodeId: host.nodeId, runs, holds,
		async close() { for (const h of opened) await h.close(); },
		releaseAll() { for (const h of holds) h.release(); },
	};
}

/** Waits until every fixture operation of every service is ready to call on the host. */
export async function readyAll(hooks, hostId, services = ["fixture"]) {
	for (const service of services) for (const name of [...OPERATIONS, ...PARTS_OPERATIONS]) await hooks.ready(hostId, `${service}/${name}`);
}
