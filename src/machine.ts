/**
 * Public surface of operation-proxy's machine adapter, for Linux (CONTRACT.md, PX1 to PX7, PX9): an
 * operating-system process for the proxy, a Unix domain socket for the channel and an abstract-namespace
 * socket for ownership, in the runtime directory the user database names. On macOS, which has no abstract
 * namespace, it is a named non-claim.
 *
 * createMachineClient - the client half on this machine, launching the proxy on demand.
 * startMachineProxy - the proxy run in this process, for an application or a test that composes it.
 * runMachineProxy - this process run as the proxy, as the application's launching command does.
 */
export { createMachineClient, runMachineProxy, startMachineProxy, type LaunchCommand, type MachineClientApplication, type MachineClientOptions, type MachineProxy, type MachineProxyApplication, type MachineProxyOptions, type ProxiedCaller, type ProxyStage } from "./machine-adapter.js";
