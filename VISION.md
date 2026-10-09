# operation-proxy - Vision

**Status: drafted 2026-10-09 under zorg's `D29` and renamed under its `D30`; not ratified.**\
This document states why operation-proxy exists and what it will never be.\
It carries no current state, no roadmap, and no schedule.

Holding this document authorises nothing.\
It does not ratify a decision, admit a component to any registry, or approve a contract change.\
Until the director ratifies it, it is a proposal, and nothing may cite it as enduring.\
A change of direction is recorded as a decision first and absorbed here afterwards.

---

## North star

> Let short-lived processes invoke named operations through one long-lived caller they share, and learn how each invocation ended exactly as if they had called it themselves - including when the honest answer is that it cannot be known.

Four terms in that sentence carry weight, so this document defines them rather than leaving them to the reader.

**Short-lived process** means a program that starts, makes a few invocations, and exits, such as a command an agent runs or a hook a tool fires.\
It does not live long enough to be worth joining the delivery beneath on its own.

**Long-lived caller** means one process per identity on one machine, holding the one connection to the delivery beneath and invoking on behalf of the processes it serves.\
The first process that needs it starts it, and it ends when nothing has used it for a time the application states.

**Share** means every short-lived process of one identity on one machine reaches the same caller.\
Processes running at once are carried over its one connection, rather than each making its own.

**Exactly as if they had called it themselves** means the same four endings a direct call gives - answered, refused with a reason, not delivered, or unknown - under the bound the short-lived process chose.\
The extra hop to the caller can add unknowns where it loses certainty; it never turns an unknown into an answer or a failure, and never gives one invocation two endings.

---

## Why it exists

Named delivery lives in a node that a program embeds.\
A program that runs for a moment and exits must either join the delivery beneath for every command - connect, exchange routes, say where answers should come back, then leave - or reach a caller that is already there.

Joining for every command churns the routing every other participant relies on, makes each command wait for routes before it can call, and turns one agent into many short-lived identities.\
Every application with a command-line client, a script, or a hook meets this.\
Each would otherwise build its own local daemon, its own way for processes to reach it, and its own way to lose an ending across the extra hop.

operation-proxy builds that once, so a short-lived process can call as cheaply and as honestly as a long-lived one.

---

## What it is

Two halves.\
A proxy process holds the calling side of the call layer beneath, for one identity, over one long-lived connection.\
A client half is embedded by each short-lived process and offers the same caller interface the call layer offers, so code written against the call layer runs through the proxy unchanged.

It is embedded by an application that owns its own configuration: what the proxy connects to, under which identity, and how long it waits when idle.

---

## What it is not

**Not the call layer.**\
It does not pair replies, time out calls, or shape refusals.\
The call layer beneath does, and the proxy carries its endings without changing them.

**Not a router, and not a node of its own choosing.**\
It never decides where an operation runs or whether it is reachable.\
It holds the one connection the call layer needs, configured by the application.

**Not a store or a queue.**\
It holds nothing that must survive its own restart.\
An invocation in flight when the proxy stops ends, for its process, as unknown, and the proxy never takes an invocation it cannot pass on.

**Not a retrier.**\
It never repeats an invocation on its own.\
It carries each invocation's identity unchanged, so whatever owns the effect can recognise a repeat the process makes.

**Not shared between identities.**\
One proxy serves one identity.\
It never carries a process's invocation under another identity, so who is calling stays what the delivery beneath reports.

**Not a network service.**\
It serves processes on its own machine, over a local channel, and never listens on the network.\
Which processes may use an identity's proxy is decided by the machine's own access rules on that channel.

**Not an authority.**\
It passes on the call layer's evidence of who is calling and decides nothing about what a caller may do.

**Not agentic.**\
It carries calls for agentic systems and contains no cognition, model, or orchestration.

---

## What success means

Four dimensions.\
They are not weighted, and they do not collapse.

**Honest endings.**\
Every invocation through the proxy ends exactly once, within its bound, in the outcome that is true.\
The measure is that the proxy stopping, a process vanishing, or the local channel failing produce more unknowns - never a hang, a second ending, or an unknown reported as an answer or a failure.

**Transparency.**\
Code written for the call layer runs through the proxy unchanged.\
The measure is that the call layer's own guarantee checks, run through the proxy, give the same results as run directly.

**Leanness.**\
A short-lived process pays little for the proxy, and its user sets nothing up.\
The measure is the cost of the first invocation, which may start the proxy, and of each later one, stated and small against a direct call.

**Reuse.**\
A second, unrelated application adopts it without a variant, a fork, or a privileged path.

A programme strong on three of these and weak on one has one unmet dimension, and which one it is says more than any average of the four.

---

## Authority

Held by the director.\
Drafted by anyone; ratified only by the director.

This statement is amended, never quietly rewritten.\
A ruling that changes direction is recorded as a decision and absorbed here, so the reasoning survives the change.

Where this narrative and a verified record disagree about state, the record governs.
