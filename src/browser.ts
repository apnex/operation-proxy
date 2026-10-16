/**
 * Public surface of `@apnex/operation-proxy/browser`: the browser `SharedWorker` and `MessagePort` adapter of
 * PX8 (zorg's D31, D57, D58).
 */
export {
	createBrowserClient,
	runBrowserProxy,
	type BrowserClientApplication,
	type BrowserClientOptions,
	type BrowserMessagePort,
	type BrowserProxiedCaller,
	type BrowserProxy,
	type BrowserProxyApplication,
	type BrowserProxyOptions,
	type BrowserWorkerScope,
	type PingMessage,
} from "./browser-adapter.js";
