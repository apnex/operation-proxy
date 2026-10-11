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
| `proxied-invocation` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity`, `operation-call:request-correlation` | A short-lived process invokes a named operation through the proxy and gets exactly one ending, within the bound it chose, kept across the hop: the ending of the direct call the proxy makes for it, with a bound a hop allowance shorter (`PX5`), unchanged, when it reaches the process before the bound passes, not delivered with the proxy's code when nothing of the invocation was handed on (`PX6`), and otherwise unknown - never an answer, never not delivered - with the hop's reason and no AGP code or delivery report, both where the hop loses certainty and where the call layer's ending has not been produced or carried back by the process's own bound; an invocation's identity is the same through the proxy as in a direct call, an invocation whose process has gone is finished and its ending dropped, and the proxy never repeats an invocation on its own. | none |
| `caller-interface-parity` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity` | The client half offers the caller interface the call layer offers, so code written against the call layer runs through the proxy unchanged. | none |
| `proxy-on-demand` | provides | none | A proxy is there when the first process of an application, identity and target needs it, with nothing set up beforehand: on a machine, processes that start at once end with one proxy, and a proxy left behind by a crash is replaced; in a browser, the browser keeps one per application, identity and target. | none |
| `proxy-idle-expiry` | provides | none | A proxy on a machine ends itself after an idle time the application states, and never ends itself while an invocation it carries is in flight; in a browser, the browser ends it after the last page that uses it. | none |
| `one-identity-per-proxy` | provides | none | Each proxy carries one application's invocations under one identity to one target, through one caller of the call layer and its one connection, invocations from processes running at once carried at the same time, and never carries a process's invocation under another identity. | none |
| `host-local-proxy-channel` | provides | none | A proxy is reached only over a channel local to its host, never over the network, and which processes may reach it is decided by the host's own access rules on that channel. | none |

The component holds nothing across a restart, coordinates no actors and contains no model, so none of its capabilities brings a trait.\
The processes one proxy serves act under one identity, so sharing it does not make a system multi-agent.

The channel and the hosting are adapters, an operating-system process and a local socket first, a browser's shared worker and message ports when a browser client needs them (zorg's `D31`); the design is below.

---

## Proxy design

**Maturity: provisional**, designed under zorg's Delta 1, amendment 1, and zorg's rulings `D28` to `D31` and `D34`.\
Each declaration names the exit criterion of zorg's `docs/DELTAS/DELTA-1.md` that proves it and the test that exercises it.\
The call layer is operation-call; its endings, bound, abort signal and invocation identities are those of zorg's `docs/ARCHITECTURE-TARGET.md`, `EM11` and `EM12`.

**PX1 - Keys, halves and adapters.**\
A proxy serves one key: an application and an identity, each matching `^[a-z0-9][a-z0-9-]{0,62}$`, and a target, a string of 1 to 2048 characters naming what the proxy's caller connects to.\
The key's digest is the first 16 lowercase hexadecimal digits of the SHA-256 of the UTF-8 bytes of `<application>\n<identity>\n<target>`.\
The proxy half runs in the proxy process and holds one caller of the call layer, which the application builds from the key; the client half runs in each short-lived process and offers the call layer's caller interface.\
Hosting and the channel are adapters: the machine adapter - an operating-system process, a Unix domain socket for the channel and an abstract-namespace socket for ownership - is built in Delta 1 for Linux, and the browser adapter of `PX8` is declared and not built; on macOS, which has no abstract namespace, the machine adapter is a named non-claim.\
Tested by: `E17`, in `test/contract/one-identity-per-proxy.test.js`, with a fixture application, including two keys differing only in target, which get two proxies, and one key used from 20 processes, which gets one.

**PX2 - Where a proxy is found on a machine.**\
The runtime directory is `.operation-proxy` in the user's home directory as the system's user database records it, never as an environment variable says, so every process of the user on the host agrees on it; a channel socket path that would be longer than 107 bytes is refused, ending the invocation `not-delivered` with `proxyCode` `runtime-dir-unsafe`.\
The client half creates it with mode `0700` when it is absent, and refuses one that is not a directory, is not owned by the user, or grants any permission to the group or to others, ending the invocation `not-delivered` with `proxyCode` `runtime-dir-unsafe`.\
In it, the file `secret` holds 32 random lowercase hexadecimal digits and a newline: a process finding no `secret` writes a complete one, with mode `0600`, to `secret.<16 random hexadecimal digits>`, links that file to `secret`, which succeeds for one process only, and removes its own file, so `secret` only ever appears whole; every process then reads `secret`, and one that is not exactly 33 bytes of that form ends the invocation `not-delivered` with `proxyCode` `runtime-dir-unsafe`.\
A key's channel is the socket `<runtime directory>/<digest>.sock`, and its ownership is the abstract-namespace socket `operation-proxy-<secret>-<digest>`, which another user cannot name without reading the secret.\
So only the user's own processes reach a proxy, and no proxy listens on the network.\
Tested by: `E17`, in `test/contract/host-local-proxy-channel.test.js`, which checks the modes, refuses a directory open to others and a malformed `secret`, finds one proxy for commands of one key run with different `HOME`, `TMPDIR` and `XDG_RUNTIME_DIR` settings, finds no listening network port, and starts 20 first-ever clients at once, and a client killed before and after linking, each leaving one agreed secret.

**PX3 - Owning a proxy, exactly once, on a machine.**\
A proxy owns its key while it listens on the key's abstract-namespace socket, which the operating system lets one process hold at a time and frees the moment that process ends, `SIGKILL` included.\
A starting proxy listens there first; if the address is in use, another proxy owns the key, and this one exits with status 0, touching nothing.\
Only the owner touches the channel socket: it removes any socket file left at that path, listens there, and then builds its caller; on a normal exit it closes and removes the channel socket before it stops listening on the ownership socket, and after `SIGKILL` the next owner removes the leftover file.\
The client half connects to the channel socket; when there is nothing to connect to, it launches the proxy with the command the application supplies, detached from itself and with its output discarded, and connects again every 100 milliseconds, launching again at most every 500 milliseconds, until the invocation's connect deadline.\
Tested by: `E17`, in `test/contract/proxy-on-demand.test.js`: 20 processes started at once leave one owner; a proxy killed with `SIGKILL` just after taking ownership, just after listening on the channel, and while serving, is each time replaced by the next command within zorg's default connect timeout of 5 seconds; a proxy paused with `SIGSTOP` keeps ownership, so no second proxy starts and a command ends `not-delivered` with `proxy-unreachable` at its connect deadline; a starter that loses never removes the channel socket.

**PX4 - The channel's messages.**\
The channel carries newline-delimited JSON in UTF-8, one message per line, each line at most 16785408 bytes with its newline - the largest request message the call layer sends, 16777216 bytes (`EM11`), and 8192 bytes for the channel's own fields; every message is an object holding `operationProxy`, which is 1, `type`, and the fields its type names:

| Direction | `type` | Fields |
|---|---|---|
| client to proxy | `hello` | `key`, holding `application`, `identity` and `target` |
| proxy to client | `welcome` | none |
| proxy to client | `refused` | `code`: `key-mismatch` or `version` |
| client to proxy | `invoke` | `request`, a whole number from 1, new for each invocation on the connection; `invocation`, an invocation identity as `EM11` writes it; `host`; `service`, the name the operation is served under, matching the identity pattern of `PX1`; `operation`, the operation's own name, matching the same pattern; `input`; `deadline`, the moment the bound passes, as `PX5` writes it; `repeat`, true or false; `aborted`, true or false |
| client to proxy | `abort` | `request` |
| proxy to client | `end` | `request`; `ending`, the call layer's ending as `EM12` gives it, or the proxy's of `PX5` |

The client sends `hello` first and nothing else until `welcome`; the proxy sends `welcome` only once its caller is ready by the application's own test (`PX9`), and answers a key other than its own, or a version other than 1, with `refused` and closes.\
A connection carries any number of invocations at once, and their messages arrive in any order, paired by `request`; an `abort` for a request already ended is ignored.\
A line that is longer, does not parse, or breaks this table closes the connection.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`.

**PX5 - Preparing, the bound, and when a proxied call is made.**\
The client half offers the call layer's caller interface, and one more step, preparing: connecting, sending `hello` and receiving `welcome`, until a deadline the caller gives.\
Before it writes an invocation, the client half applies the call layer's own checks on the caller's side (`EM11`) - numbers, depth, and a request message of at most 16777216 bytes - and ends one that fails them exactly as the call layer would, refused as `not-sendable`, so every invocation it writes fits a line.\
An invocation's bound starts when the caller invokes, as `EM12` says; when the client half is not prepared then, preparing happens within that bound, and a connection lost between invocations is prepared again within the next invocation's bound, so a find's pages keep the one deadline `EM10` gives them.\
The client half keeps its own deadline - the moment the caller's bound passes - and gives the proxy's call a deadline a hop allowance sooner: the application's allowance (`PX9`), by default 50 milliseconds, or half the caller's bound if that is less, rounded down to a whole millisecond.\
So an invocation through the proxy ends exactly as the direct call the proxy makes for it ends (zorg's `D48`): that call is made when the proxy hands the invocation on, with the abort signal as the proxy relays it, and with a bound ending at the sooner deadline - on a machine; in a browser, `PX8` - rounded down to a whole millisecond, so its own deadline falls between the allowance and the allowance plus less than 1 millisecond before the client half's deadline - a call that runs out its bound decides there, and one answered or refused sooner decides when that happens.\
Every event that call meets after its own bound - an answer, a refusal, a delivery report - is one it does not take; and an abort the process gives reaches it only when the relayed `abort` arrives, so an abort that crosses the hop while the send is being admitted may arrive after admission, where it changes nothing (`EM12`).\
Its ending is taken whenever the client half reads it before its own deadline, and an `end` read at or after that deadline loses (`PX6`); a return transit shorter than the allowance is enough for that, not required, since an ending decided early, or a deadline floored short of the allowance, leaves more time; an allowance of 0 - an application's own, or a bound of 1 millisecond - leaves no margin, and such an invocation may end `hop-stalled`.\
The rule applies to each invocation by its own deadline and its own allowance, so a find's pages each keep it, each page's bound being the time `EM10` leaves it.\
On a machine, the client half sends as `deadline` that sooner deadline, on Linux's `CLOCK_MONOTONIC`, in nanoseconds, as Node's `process.hrtime.bigint()` gives it, written in decimal: one clock for every process on the machine, which a change to the wall clock does not move.\
The proxy hands each invocation to its caller as it arrives, keeping no backlog: addressed to the endpoint `<service>/<operation>` on its host, with its operation's name, its invocation identity, its repeat flag, a bound of `deadline` less the proxy's own reading of that clock, rounded down to a whole millisecond and at most 2147483647, and an abort signal that is already fired when `aborted` is true and that the proxy fires on `abort`.\
When less than 1 millisecond is left as the invocation arrives, the proxy does not hand it on, and answers `end` with `not-delivered`, `proxyCode` `deadline-passed` - the ending of a direct call that could not be made with a bound of a whole millisecond - so a bound of 2 milliseconds with an allowance of 1, whose sooner deadline leaves 1, is refused so whenever the hop takes any time at all, while with an application allowance of 0 it can be made.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`, with the whole wire record of two calls alike but for their `service`, reaching two endpoints over one proxy, an input making a request message of exactly 16777216 bytes and one of a byte more, another call in flight and a small one after each, a hop delayed in each direction, preparing that takes part of the bound, a find of several pages whose connection is lost between pages, the wall clock stepped forward and back while a call is in flight, the largest bound, the deadline sent for the default allowance, for an application's own allowance, and for bounds of 99, 100, 101, 2 and 1 milliseconds, whose allowances are 49, 50, 50, 1 and 0, the bound of 2 also with an application allowance of 0, each run to its ending as well as checked on the wire, and an allowance of 0 and of 1000, each run to its ending; every case records the direct call the proxy made - its moment, bound and abort - and checks the ending against it, with returns taking just less than the allowance, exactly the allowance and just more, at whole and fractional milliseconds - including a return longer than the allowance that is still read before the client half's deadline, its ending taken unchanged, after a timeout decided at a floored deadline and after an early answer - an answer, a refusal, a rejection and a delivery report observed at or after the proxy's call's deadline before its own timer has run, each losing to that deadline, and a find of 100 milliseconds whose later page is handed on with 80 milliseconds gone, its transmitted deadline and its ending checked, and an abort crossing the hop while the send is held for admission, arriving before and after admission; an abort before the send is admitted, which ends `not-delivered` with `agpCode` `ABORTED`, and one after, which changes nothing.

**PX6 - How a proxied invocation ends.**\
The first of these events decides the ending, and nothing after it changes it:

| Event | Ending |
|---|---|
| No proxy has answered `welcome` by the connect deadline, and nothing of the invocation was written | `not-delivered`, with `proxyCode` `proxy-unreachable` |
| The proxy answers `refused` | `not-delivered`, with `proxyCode` the refusal's `code` |
| An `end` message for the invocation | its ending, unchanged |
| After any byte of the `invoke` message was written, the channel closes or carries a malformed line | `unknown`, with `reason` `proxy-lost` |
| The client half's own deadline passes before it has read the invocation's `end` - the proxy has not produced it, or the hop has not carried it | `unknown`, with `reason` `hop-stalled` |

A channel that closes after `welcome` and before any byte of an invocation is written is no proxy at all, and the client half connects and launches again until the connect deadline.\
A `not-delivered` ending of the call layer carries `proxyCode` `null`; one of the proxy carries `agpCode` `null`; an `unknown` ending the client half decides carries `agpCode` `null` and `deliveryReport` `null`, since the call layer's delivery reports stay with the proxy.\
The client half's deadline is a moment on its clock: an `end` read before it wins, and an `end` read at or after it is discarded, whichever runs first, the timer or the read.\
The rows above that end an invocation by the proxy's own code or by `proxy-lost` take precedence over `hop-stalled`, which ends only an invocation that nothing else has ended by the client half's deadline.\
So an invocation ends as `PX5`'s rule says whenever the proxy's call's ending is read before the client half's deadline - one that runs out its bound ending `unknown` with `bound-passed` and the call layer's delivery report, up to the allowance plus less than 1 millisecond early - and an invocation whose ending the proxy has not produced, or the hop has not carried, by that deadline ends `unknown` with `hop-stalled`, where nothing more is known; a delay longer than the allowance does not by itself mean `hop-stalled`, since an ending decided early can still arrive in time.\
An abort sent across the hop changes the ending only as the call layer decides it, never by the client half alone.\
When a short-lived process goes, the proxy finishes its calls and drops their endings, and never repeats an invocation.\
Tested by: `E17`, in `test/contract/proxied-invocation.test.js`: each of the call layer's four endings arrives through the proxy as from a direct call; a proxy killed after the invocation was written ends it `unknown` with `proxy-lost` at once; a proxy stopped with `SIGSTOP` ends it `unknown` with `hop-stalled` at the bound; a call that runs out its bound through a working proxy ends `unknown` with `bound-passed` and the call layer's delivery report, before the client half's bound passes; a hop whose fixture holds the proxy half's writing of an `end` until after the client half's deadline ends it `unknown` with `hop-stalled`, and the ending released afterwards is discarded; a proxy process stopped with `SIGSTOP` before its call decides, so that it produces no ending by the client half's deadline, ends it `unknown` with `hop-stalled`, and after `SIGCONT` its ending is discarded; an application allowance of 0, whose invocation runs out its bound, ending `bound-passed` or `hop-stalled`, as the race falls, and never otherwise; and an answer, a refusal and a delivery report each falling between the proxy's call's bound and the client half's deadline, none taken; a channel closed after `welcome` and before writing leads to a new proxy; a client killed during a call leaves the fixture host one request and the proxy no second.

**PX7 - Idle ending and stopping on a machine.**\
A proxy is idle while no connection is open and no call is in flight; when its idle timer of the application's idle time, from 1 second to 24 hours, fires, it checks again, and stays if a connection is open or a call is in flight.\
Otherwise, and on `SIGTERM` or `SIGINT` once each call in flight has ended within its bound and its ending has been sent, it stops accepting connections, closes those not welcomed, closes and removes the channel socket, stops its caller, and stops listening on the ownership socket last, then exits with status 0.\
A client whose connection closes before `welcome` treats it as no proxy (`PX6`), and the next owner can only take the key after the last step.\
Tested by: `E17`, in `test/contract/proxy-idle-expiry.test.js`, with an injected clock for the proxy half and one real process with an idle time of 1 second, including a client connecting as the idle timer fires and a call in flight past the idle time, which keeps the proxy running.

**PX8 - The browser adapter, declared.**\
In a browser, the client half reaches a shared worker created from the application's worker script with the name `operation-proxy:<digest>`, through one message port per page, carrying `PX4`'s messages as objects; there, since a page and a worker share no clock, `deadline` is instead the milliseconds left until `PX5`'s sooner deadline at the moment the page posts the message, by the page's `performance.now()`, and the worker's call is bound by that many milliseconds from the moment it receives the message, by its own `performance.now()`, rounded down as `PX5` says; so each side reads only its own clock; the worker's call's deadline is then its receipt plus that remaining time floored, which can be the outbound transit plus less than 1 millisecond later than a machine's would be, and its ending reaches the page in time whenever the outbound and return transits together take less than the allowance, which a browser application chooses to cover them; a message delayed past the page's deadline may still start its call, whose ending the page discards, having ended the invocation `hop-stalled`, which says the operation may have run; and a message whose remaining time at posting is a whole millisecond or more is admitted however late it arrives, while one with less is refused `deadline-passed`; with one more type for this adapter only: `{"operationProxy": 1, "type": "ping"}`, sent by each side every 5 seconds, since a message port reports no closing; a side that hears nothing from the other for 15 seconds treats it as gone, and a page then ends its written invocations `unknown` with `proxy-lost`.\
The browser starts the worker for the first page and ends it after the last, so there is no idle timer and no ownership socket.\
Verified as a design under `E13`; its executable test, `test/contract/browser-adapter.test.js`, is owed with the adapter, and a bound of 2 milliseconds posted with a remaining time just below and exactly 1 - a page and a worker with different time origins and wall clocks, messages whose outbound and return transits together take just less than the allowance, whose endings reach the page before its deadline; an unanswered call with a whole-millisecond remaining time whose transits together take the allowance or more, each direction alone less, its ending read at or after the page's deadline and so `hop-stalled`; transits together longer than the allowance whose ending is still read before the deadline, taken unchanged; an outbound transit crossing a whole millisecond of the worker's flooring; an answer arriving in the interval the outbound transit adds to the worker's call, taken, a message delayed past the page's deadline, whose call runs and whose ending is discarded, and a bound of 2 milliseconds with a positive transit, and a bound passing before the worker receives the invocation - and the adapter is a named non-claim of Delta 1.

**PX9 - What an application supplies.**\
The key; on a machine, the command that launches its proxy, and the idle time, the launching command's prevailing; the function that builds the proxy's caller from the key, and the test of when that caller is ready; the hop allowance, a whole number of milliseconds from 0 to 1000, by default 50; and, in a browser, the worker script.\
Tested by: `E17`, in `test/contract/one-identity-per-proxy.test.js`, with a fixture application.

**PX10 - The call layer's own checks, through the proxy.**\
The call layer, operation-call, exports its caller contract cases as `@apnex/operation-call/caller-suite`: a function taking a harness that opens each case a session - the caller under test and the fixture's hooks: the call bound's clock, to advance or move, AGP's injected clock and executor barrier, the channel-loss hook, a failure of the next send, the real clock where a case asks for it, and observations of readiness, routes, requests, delivery reports and admission - and registering every case a caller can observe (zorg's `EM12`).\
The suite it runs is operation-call's at `26c9353` or later, whose cases compute the time the call beneath is given from the bound less the allowance and all run through a hop; that update is a prerequisite of stage 4a, built in operation-call's stage 4.\
The file `test/contract/caller-interface-parity.test.js` of this component runs that suite against the client half, with the proxy half in the same process over a real channel socket and AGP's production in-process carrier, the hop intact.\
The fixture runs the client half, the proxy half and the call layer on one controllable monotonic timeline, the call bound's clock, and AGP's injected clock apart; it states the hop allowance to the suite, which then advances that timeline to the allowance's edge - at or after the proxy's call's actual deadline, which `PX5` rounds down, and before the client half's - lets the fixture observe the client half read the proxy's `end` over the real channel, asserts the ending, and only then advances to the bound and asserts that nothing changes; a case that depends on the time the call beneath is given, its admission deadline among them, computes it from the bound less the allowance, as the suite does for any caller across a hop (zorg's `EM12`).\
Every case of the suite passes through a working hop, judged by `PX5`'s rule, so a case whose call ends at its bound sees `unknown` with `bound-passed` and the call layer's delivery report up to the allowance plus less than 1 millisecond early; the suite holds no case of a held or stopped hop, which are this component's own cases in `test/contract/proxied-invocation.test.js` (`PX6`); the suite includes the size cases of `EM11`, a request over a peer's receive limit ending not delivered with `MESSAGE_TOO_LARGE`, with another call in flight and a small one following.\
Tested by: `E17`, in that file; and `E6`, in operation-call's tests, which run the same suite directly.

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
