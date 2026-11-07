// caller-interface-parity (types) - a compile-time consumer of the caller interface (CONTRACT.md,
// caller-interface-parity; zorg's target, EM12). Compiled by `npm test` with the package's own strict settings,
// emitting nothing: it passes when it compiles. It imports both packages by their public names, so it reads
// what a consumer reads.
//
// A strict TypeScript function written against operation-call's OperationCaller accepts operation-call's own
// caller and this component's client half unchanged, with no cast: code written against the call layer runs
// through the proxy unchanged, a strict TypeScript consumer included.
import { createCaller, type CallEnding, type CallRequest, type OperationCaller } from "@apnex/operation-call";
import { createProxyClient, type PreparingEnding, type ProxiedEnding, type ProxyClient } from "@apnex/operation-proxy";
import { createMachineClient } from "@apnex/operation-proxy/machine";

/** True only when two types are the same type. */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only when given true. */
const holds = <T extends true>(): T | undefined => undefined;

/** A consumer written against the interface alone: it reads every ending EM12 names, exhaustively. */
async function describe(caller: OperationCaller, call: CallRequest): Promise<string> {
	const ending: CallEnding = await caller.invoke(call);
	const attempt: string = ending.attempt ?? "no attempt of the call layer";
	switch (ending.ending) {
		case "answered": return `${attempt} answered ${JSON.stringify(ending.answer)}`;
		case "refused": return `${attempt} refused ${ending.refusal.code}`;
		case "not-delivered": return `${attempt} not delivered: ${ending.agpCode ?? ending.proxyCode}`;
		case "unknown": return `${attempt} unknown: ${ending.reason}, ${ending.agpCode ?? "no AGP code"}, ${ending.deliveryReport ?? "no report"}`;
		default: {
			const none: never = ending;
			return none;
		}
	}
}

/** operation-call's own caller, as createCaller gives it, is accepted unchanged. */
export async function directly(options: Parameters<typeof createCaller>[0], call: CallRequest): Promise<string> {
	return describe(await createCaller(options), call);
}

/** The client half over any connector, as createProxyClient gives it, is accepted unchanged. */
export function throughTheProxy(options: Parameters<typeof createProxyClient>[0], call: CallRequest): Promise<string> {
	return describe(createProxyClient(options), call);
}

/** The client half on a machine, as createMachineClient gives it, is accepted unchanged. */
export function throughTheMachineProxy(application: Parameters<typeof createMachineClient>[0], call: CallRequest): Promise<string> {
	return describe(createMachineClient(application), call);
}

/** A value of the declared client type is accepted, and assigned, unchanged. */
export function declared(client: ProxyClient, call: CallRequest): Promise<string> {
	const caller: OperationCaller = client;
	return describe(caller, call);
}

// The client half is an OperationCaller; every ending it gives is one the interface admits, and it gives the
// additions EM12 admits: attempt null, the proxy's code, and the reasons a hop adds.
holds<ProxyClient extends OperationCaller ? true : false>();
holds<ProxiedEnding extends CallEnding ? true : false>();
holds<Same<Awaited<ReturnType<ProxyClient["invoke"]>>, ProxiedEnding>>();
holds<Same<Extract<ProxiedEnding, { readonly attempt: null }>["ending"], "not-delivered" | "unknown">>();
holds<Same<Extract<ProxiedEnding, { readonly ending: "unknown"; readonly attempt: null }>["reason"], "proxy-lost" | "hop-stalled">>();
holds<Same<Extract<ProxiedEnding, { readonly ending: "not-delivered"; readonly attempt: null }>["proxyCode"], "proxy-unreachable" | "key-mismatch" | "version" | "deadline-passed" | "runtime-dir-unsafe" | "proxy-stopping" | "admission-refused">>();
// Preparing is not invoking: its ending may name no invocation, so it is not an ending of the interface.
holds<PreparingEnding extends CallEnding ? false : true>();
