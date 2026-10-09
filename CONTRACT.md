---
id: unminted
category: component
title: operation-relay - named operations from short-lived processes, through one long-lived caller they share
status: draft
hydrate-when: Short-lived processes in your system invoke named operations, and you are about to give each its own connection to the delivery beneath
sovereignty: internal
supersedes: []
related: [C0, A3]
---

# operation-relay

The contract of record for operation-relay: what a consumer can depend on, admitted to zorg's component set by the director's ruling `D29` in zorg's `docs/DECISIONS.md`.\
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
| `relayed-invocation` | provides | `operation-call:honest-call-ending`, `operation-call:caller-chosen-bound`, `operation-call:invocation-identity`, `operation-call:request-correlation` | A short-lived process invokes a named operation through the relay and gets exactly one of the call layer's endings, under the bound it chose; where the hop to the relay loses certainty, the ending is unknown, never an answer or a failure, and an invocation's identity is the same through the relay as in a direct call. | none |
| `caller-interface-parity` | provides | none | The client half offers the caller interface the call layer offers, so code written against the call layer runs through the relay unchanged. | none |
| `relay-on-demand` | provides | none | The first process that needs a relay for an identity starts it; processes that start at once end with one relay, and a relay left behind by a crash is replaced. | none |
| `relay-idle-expiry` | provides | none | A relay ends after an idle time the application states, and never while an invocation it carries is in flight. | none |
| `one-identity-per-relay` | provides | none | Each relay carries one identity's invocations over one connection to the delivery beneath, and never carries a process's invocation under another identity. | none |

The component holds nothing across a restart, coordinates no actors and contains no model, so none of its capabilities brings a trait.\
The processes one relay serves act under one identity, so sharing it does not make a system multi-agent.

Owed before it is built: the local channel and its protocol, how a relay is found and started, how the hop's failures map to endings, and the configuration an application supplies, designed under zorg's Delta 1.

---

## Reference

Not yet built.\
This repository, `apnex/operation-relay`, private until its first working code: `VISION.md` and, once built, the implementation.

---

## Fit criteria

### Does my project want this at all

- Short-lived processes in your system invoke named operations, and each is about to join the delivery beneath on its own.
- Many processes of one identity run on one machine, sometimes at once.
- A process must still tell "it failed" from "it may have happened", even though its call crosses an extra hop.

### Does it meet my requirement

- Code written against the call layer runs through the relay unchanged.
- The relay starts when first needed and ends when idle, with nothing for a user to set up.
- Every invocation ends exactly once, and "unknown" is reported rather than guessed.

**It is the wrong tool when**

| You need | Reach elsewhere, because operation-relay is |
|---|---|
| your processes long-lived anyway | unnecessary: embed the call layer directly |
| calls from other machines | not a network service |
| one connection shared by several identities | one identity per relay |
| calls that survive a restart, or are retried for you | not a store and not a retrier |
| a decision about who may call what | not an authority |

---

## Adjustment policy

Internal and sovereign, so a fit gap has somewhere to go.

1. Record a measured gap where both sides can see it.
2. Resolve it by adjusting operation-relay, so every consumer gets the change, or by fracturing it when the gap reveals a second duty.
3. Never fork.

The delivery beneath is reached through the call layer, so a new delivery layer needs no change to operation-relay.

---

## Edges

**Composes:** nothing registered.\
Its relay process and client half are halves of one duty, not separate components.

**Consumes, through a declared contract:**

- `operation-call`: `honest-call-ending`, `caller-chosen-bound`, `invocation-identity`, `request-correlation`

**Composed-by:** nothing yet.\
Its first consumer, once built, is zorg's command-line client.

The registry's edge vocabulary has no edge for one component using another's contract without containing it; see the note in operation-call's entry.
