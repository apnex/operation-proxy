/**
 * Public surface of operation-proxy, free of anything particular to one runtime (zorg's principle 6, D31):
 * the two halves over any channel and clock, the key's digest, and the channel's limits. The machine adapter
 * is `@apnex/operation-proxy/machine`; the browser adapter (PX8) is declared and not built.
 *
 * createProxyClient - proxied-invocation, caller-interface-parity: the client half over a connector.
 * createProxyHalf - proxied-invocation, one-identity-per-proxy, proxy-idle-expiry: the proxy half.
 * callClockOf - proxied-invocation: the call layer's clock port over the hop's clock, for the proxy's caller.
 * keyDigest - one-identity-per-proxy, proxy-on-demand: the digest that names a key's sockets.
 * CHANNEL_LIMITS, DEFAULT_HOP_ALLOWANCE_MS - proxied-invocation, host-local-proxy-channel: PX4's line limit, PX5's allowance.
 */
export { createProxyClient, DEFAULT_HOP_ALLOWANCE_MS, type PrepareOptions, type ProxyClient, type ProxyClientOptions, type ProxyStatus, type StatusOptions } from "./client-half.js";
export { createProxyHalf, type CallLayerCaller, type ProxyHalf, type ProxyHalfOptions } from "./proxy-half.js";
export { callClockOf, type HopClock, type HopTimer, type PinnableCallClock } from "./hop-clock.js";
export { keyDigest, type ProxyKey } from "./key.js";
export { CHANNEL_LIMITS, type ChannelMessage, type RefusalCode } from "./channel-messages.js";
export type { ChannelLink, LinkHandlers } from "./channel-link.js";
export type { ClientConnector, ConnectOutcome } from "./client-preparing.js";
export type { CarriedEnding, DeadlinePassedEnding, HopReason, HopUnknownEnding, PreparingEnding, ProxiedEnding, ProxyCode, ProxyNotDeliveredEnding } from "./endings.js";
