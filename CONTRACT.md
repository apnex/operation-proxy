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
| `proxied-invocation` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity`, `operation-call:request-correlation` | A short-lived process invokes a named operation through the proxy and gets exactly one ending, within the bound it chose, kept across the hop: the call layer's ending unchanged where it has one, and unknown - never an answer, never not delivered - where the hop loses certainty; an invocation's identity is the same through the proxy as in a direct call, and an invocation whose process has gone is finished and its ending dropped. | none |
| `caller-interface-parity` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity` | The client half offers the caller interface the call layer offers, so code written against the call layer runs through the proxy unchanged. | none |
| `proxy-on-demand` | provides | none | A proxy is there when the first process of an identity needs it, with nothing set up beforehand: on a machine, processes that start at once end with one proxy, and a proxy left behind by a crash is replaced; in a browser, the browser keeps one per identity. | none |
| `proxy-idle-expiry` | provides | none | A proxy on a machine ends after an idle time the application states, and never while an invocation it carries is in flight; in a browser, the browser ends it after the last page that uses it. | none |
| `one-identity-per-proxy` | provides | none | Each proxy carries one identity's invocations through one caller of the call layer, invocations from processes running at once carried at the same time, and never carries a process's invocation under another identity. | none |
| `host-local-proxy-channel` | provides | none | A proxy is reached only over a channel local to its host, never over the network, and which processes may reach it is decided by the host's own access rules on that channel. | none |

The component holds nothing across a restart, coordinates no actors and contains no model, so none of its capabilities brings a trait.\
The processes one proxy serves act under one identity, so sharing it does not make a system multi-agent.

Owed before it is built: the local channel and its protocol, how a proxy is found and started, how the hop's failures map to endings, and the configuration an application supplies, designed under zorg's Delta 1; the channel and the hosting are adapters, an operating-system process and a local socket first, a browser's shared worker and message channel when a browser client needs them (zorg's `D31`).

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
