// fixture-hosts - operation-call hosts on the topology's host nodes, serving fixture operations under one or
// more service names, each run recorded, so a test sees exactly what reached the operation's host.
//
// `echo` answers its input; `which` answers the host, the service and the identities it was given; `hold`
// waits until the test releases that run, then answers like `which`; `hold-refuses` waits, then refuses with
// the refusal record its input holds; `silent` never answers; `refuses` refuses with its input; `throws` throws.
import { createOperationHost } from "@apnex/operation-call";

export const ANY = Object.freeze({ $schema: "urn:apnex:shape-check:dialect:1" });
export const OPERATIONS = ["echo", "which", "hold", "hold-refuses", "silent", "refuses", "throws"];

/** A latch an operation waits on and a test releases. */
export function latch() {
	const { promise, resolve } = Promise.withResolvers();
	return { wait: promise, release: () => resolve() };
}

/** Opens fixture hosts under each service on a host node; gives its runs and the latches of its held runs. */
export async function openFixtureHost(host, services = ["fixture"]) {
	const runs = [];
	const holds = [];
	const opened = [];
	for (const service of services) {
		const opening = await createOperationHost(host.node, { service });
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
		for (const name of OPERATIONS) {
			const declared = await opening.host.declare({ name, input: ANY, answers: "whole" }, (input, c) => {
				runs.push({ service, operation: c.operation, input, invocation: c.invocation, attempt: c.attempt, origin: c.delivery.source.originNodeId });
				return handlers[name](input, c);
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
	for (const service of services) for (const name of OPERATIONS) await hooks.ready(hostId, `${service}/${name}`);
}
