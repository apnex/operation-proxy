---
id: unminted
category: component
title: operation-proxy - named operations from short-lived processes, through one long-lived caller they share
status: draft
hydrate-when: Short-lived processes in your system invoke named operations, and you are about to give each its own connection to the delivery beneath
sovereignty: internal
supersedes: []
related: [C0, A3]
---

# operation-proxy

The contract of record for operation-proxy: what a consumer can depend on, admitted to zorg's component set by the director's ruling `D29` in zorg's `docs/DECISIONS.md`, and named by its `D30`; its vision awaits the director's ratification, and until then this contract is a draft.\
It also carries the fields of a mission-kit registry entry, and that entry is generated from this file when the component is filed, never written as a second copy.\
The registry id is unminted on purpose; one is minted only when the entry is admitted to the registry.

**Status: drafted with the vision, and changed with it until the vision is ratified.**

---

## Duty

Let short-lived processes invoke named operations through one long-lived caller they share, each invocation still ending honestly.

---

## Contract

What a consumer can depend on, one capability per row.\
A capability is named for what it offers, not for who offers it, so two components that provide the same capability share its name, and the overlap is visible.\
**Provides** means this component implements the capability; **carries from X** means it passes X's capability through its own interface.\
**Requires** names the capabilities of other components a row depends on, as `component:capability`, so a census can follow an application's demand down through the components it reaches.\
The trait column names any trait a system takes on by using the capability.

| Capability | Relation | Requires | What a consumer can depend on | Trait |
|---|---|---|---|---|
| `proxied-invocation` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity`, `operation-call:request-correlation` | A short-lived process invokes a named operation through the proxy and gets exactly one ending, within the bound it chose, kept across the hop: the call layer's ending unchanged where it has one, and unknown - never an answer, never not delivered - where the hop loses certainty; an invocation's identity is the same through the proxy as in a direct call, an invocation whose process has gone is finished and its ending dropped, and the proxy never repeats an invocation on its own. | none |
| `caller-interface-parity` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity` | The client half offers the caller interface the call layer offers, so code written against the call layer runs through the proxy unchanged. | none |
| `proxy-on-demand` | provides | none | A proxy is there when the first process of an application and identity needs it, with nothing set up beforehand: on a machine, processes that start at once end with one proxy, and a proxy left behind by a crash is replaced; in a browser, the browser keeps one per application and identity. | none |
| `proxy-idle-expiry` | provides | none | A proxy on a machine ends itself after an idle time the application states, and never ends itself while an invocation it carries is in flight; in a browser, the browser ends it after the last page that uses it. | none |
| `one-identity-per-proxy` | provides | none | Each proxy carries one application's invocations under one identity, through one caller of the call layer and its one connection, invocations from processes running at once carried at the same time, and never carries a process's invocation under another identity. | none |
| `host-local-proxy-channel` | provides | none | A proxy is reached only over a channel local to its host, never over the network, and which processes may reach it is decided by the host's own access rules on that channel. | none |

The component holds nothing across a restart, coordinates no actors and contains no model, so none of its capabilities brings a trait.\
The processes one proxy serves act under one identity, so sharing it does not make a system multi-agent.

The channel and the hosting are adapters, an operating-system process and a local socket first, a browser's shared worker and message ports when a browser client needs them (zorg's `D31`); the design is below.

---

## Proxy design

**Maturity: provisional**, designed under zorg's Delta 1, amendment 1, and zorg's rulings `D28` to `D31`.\
Each declaration names the exit criterion of zorg's `docs/DELTAS/DELTA-1.md` that proves it and the test that exercises it.\
The call layer is operation-call; its endings, bound and invocation identities are those of zorg's `docs/ARCHITECTURE-TARGET.md`, `EM11` and `EM12`.

**PX1 - Keys, halves and adapters.**\
A proxy serves one key: an application and an identity, each matching `^[a-z0-9][a-z0-9-]{0,62}$`, and a target, a string of 1 to 2048 characters the application uses to say what the proxy's caller reaches.\
The key's digest is the first 16 lowercase hexadecimal digits of the SHA-256 of the UTF-8 bytes of `<application>\n<identity>\n<target>`.\
The proxy half runs in the proxy process and holds one caller of the call layer, which the application builds from the key; the client half runs in each short-lived process and offers the call layer's caller interface.\
Hosting and the channel are adapters: the machine adapter - an operating-system process and a Unix domain socket, on Linux and macOS - is built in Delta 1, and the browser adapter of `PX8` is declared and not built.\
Tested by: `E17`, in `test/contract/one-identity-per-proxy.test.js`.

**PX2 - Where a proxy is found on a machine.**\
The runtime directory is `$XDG_RUNTIME_DIR/operation-proxy` when that variable is set, and otherwise `<the operating system's temporary directory>/operation-proxy-<the user's numeric id>`.\
The client half creates it with mode `0700` when it is absent, and refuses one that is not a directory, is not owned by the user, or grants any permission to the group or to others.\
A key's socket is `<runtime directory>/<digest>.sock`, and its lock is the directory `<runtime directory>/<digest>.lock`.\
So only the user's own processes reach a proxy, and no proxy listens on the network.\
Tested by: `E17`, in `test/contract/host-local-proxy-channel.test.js`, which checks the modes, refuses a directory open to others, and finds no listening network port.

**PX3 - Starting exactly one proxy on a machine.**\
The client half connects to the key's socket.\
When there is nothing to connect to, it launches the proxy with the command the application supplies, detached from itself and with its output discarded, and tries again every 100 milliseconds, launching again at most once a second, until the invocation's connect deadline.\
A proxy starting creates the lock directory, which only one process can do.\
When the lock exists, the starting proxy connects to the socket: if that succeeds, or the lock is less than 10 seconds old by its modification time, it exits, leaving the running or starting proxy in place; otherwise the lock is stale, and the proxy renames it to a unique name, which only one process can do, removes it, and creates the lock once more, exiting if that fails.\
Holding the lock, the proxy writes its process id into it, removes any socket left at the socket's path, listens, and only then builds its caller.\
On every exit it closes the listener, removes the socket and removes the lock.\
Tested by: `E17`, in `test/contract/proxy-on-demand.test.js`: 20 processes started at once leave one proxy; a proxy killed with `SIGKILL` leaves a lock and a socket, and the next process starts a new proxy; a lock less than 10 seconds old is left in place.

**PX4 - The channel's messages.**\
The channel carries newline-delimited JSON in UTF-8, one message per line, each line at most 4194304 bytes with its newline; every message is an object holding `operationProxy`, which is 1, `type`, and the fields its type names:

| Direction | `type` | Fields |
|---|---|---|
| client to proxy | `hello` | `key`, holding `application`, `identity` and `target` |
| proxy to client | `welcome` | none |
| proxy to client | `refused` | `code`: `key-mismatch` or `version` |
| client to proxy | `invoke` | `request`, a whole number from 1, new for each invocation on the connection; `invocation`, an invocation identity as `EM11` writes it; `host`; `operation`; `input`; `boundMs`, from 1 to 2147483647; `connectDeadline`, milliseconds since the epoch; `repeat`, true or false |
| proxy to client | `started` | `request` |
| proxy to client | `end` | `request`; `ending`, the call layer's ending as `EM12` gives it |

The client sends `hello` first and nothing else until it gets `welcome`; the proxy answers a key other than its own, or a version other than 1, with `refused` and closes.\
A connection carries any number of invocations at once, and their messages arrive in any order, paired by `request`.\
A line that is longer, does not parse, or breaks this table closes the connection.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`.

**PX5 - When a proxied call starts, and its bound.**\
The proxy hands an invocation to its caller - with its invocation identity, its host, its bound of `boundMs`, and its repeat flag - as soon as the caller is ready by the application's own test, or at `connectDeadline`, whichever comes first, and then sends `started`.\
So the wait to reach the target does not count against the call's bound, and a call that could not reach it is still made and ends as the call layer decides.\
The client half's deadline for an invocation is `connectDeadline` plus `boundMs` plus 2000 milliseconds.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`, with a caller made ready late, and one never made ready.

**PX6 - How a proxied invocation ends.**\
The first of these events decides the ending, and nothing after it changes it:

| Event | Ending |
|---|---|
| No proxy has answered `welcome` by `connectDeadline` | `not-delivered`, with `proxyCode` `proxy-unreachable` |
| The proxy answers `refused` | `not-delivered`, with `proxyCode` the refusal's `code` |
| An `end` message for the invocation | the call layer's ending, unchanged |
| After any byte of the `invoke` message was written, the channel closes or carries a malformed line | `unknown`, with `reason` `proxy-lost` |
| The client half's deadline passes | `unknown`, with `reason` `hop-stalled` |

A `not-delivered` ending of the call layer carries `proxyCode` `null`; one of the proxy carries `agpCode` `null`.\
When a short-lived process goes, the proxy finishes its calls and drops their endings, and never repeats an invocation.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`: each of the call layer's four endings arrives through the proxy as it does from a direct call, against one fixture host over AGP's production in-process carrier; a proxy killed after `started` ends the call `unknown` with `proxy-lost` at once; a proxy stopped with `SIGSTOP` ends it `unknown` with `hop-stalled` at the deadline; a client killed during a call leaves the fixture host one request and the proxy no second.

**PX7 - Idle ending and stopping on a machine.**\
A proxy is idle while no client is connected and no call is in flight; idle for the time the application states, from 1 second to 24 hours, it closes its listener, removes its socket and lock, stops its caller and exits with status 0.\
On `SIGTERM` or `SIGINT` it does the same, after waiting for each call in flight to end, which each does within its bound, and sending its ending.\
Tested by: `E17`, in `test/contract/proxy-idle-expiry.test.js`, with an injected clock for the proxy half and one real process with an idle time of 1 second; a call in flight past the idle time keeps the proxy running.

**PX8 - The browser adapter, declared.**\
In a browser, the client half reaches a shared worker created from the application's worker script with the name `operation-proxy:<digest>`, through one message port per page, carrying `PX4`'s messages as objects.\
The browser starts the worker for the first page and ends it after the last, so there is no idle timer.\
A message port reports no closing, so each side sends `{"operationProxy": 1, "type": "ping"}` every 5 seconds and treats the other as gone after 15 seconds without one; a page then ends its written invocations `unknown` with `proxy-lost`.\
Not built or tested in Delta 1; it is a named non-claim of the delta.

**PX9 - What an application supplies.**\
The key; on a machine, the command that launches its proxy, and the idle time; the function that builds the proxy's caller from the key, and the test of when that caller is ready; and, in a browser, the worker script.\
Tested by: `E17`, in `test/contract/one-identity-per-proxy.test.js`, with a fixture application.

---

## Reference

Not yet built.\
This repository, `apnex/operation-proxy`, private until its first working code: `VISION.md` and, once built, the implementation.

---

## Fit criteria

### Does my project want this at all

- Short-lived processes in your system invoke named operations, and each is about to join the delivery beneath on its own.
- Many processes of one identity run on one host - a machine or a browser - sometimes at once.
- A process must still tell "it failed" from "it may have happened", even though its call crosses an extra hop.

### Does it meet my requirement

- Code written against the call layer runs through the proxy unchanged.
- The proxy starts when first needed and ends when idle, with nothing for a user to set up.
- Every invocation ends exactly once, and "unknown" is reported rather than guessed.

**It is the wrong tool when**

| You need | Reach elsewhere, because operation-proxy is |
|---|---|
| your processes long-lived anyway | unnecessary: embed the call layer directly |
| calls from other machines | not a network service |
| one connection shared by several identities | one identity per proxy |
| calls that survive a restart, or are retried for you | not a store and not a retrier |
| a decision about who may call what | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting operation-proxy, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

The delivery beneath is reached through the call layer, so a new delivery layer needs no change to operation-proxy.

---

## Edges

**Composes:** nothing registered.\
Its proxy process and client half are halves of one duty, not separate components.

**Consumes, through a declared contract:**

- `operation-call`: `honest-call-ending`, `caller-chosen-bound`, `invocation-identity`, `request-correlation`

**Composed-by:** nothing yet.\
Its first consumer, once built, is zorg's command-line client.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in operation-call's entry.
