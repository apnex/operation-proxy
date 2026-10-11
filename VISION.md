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

Four terms in that sentence carry weight, so this document defines them rather than leaving them to the reader; a *host* is one machine, or one browser.

**Short-lived process** means a program that may end at any moment and is one of many under its identity, such as a command an agent runs, a hook a tool fires, or a page open in a browser tab.\
Joining the delivery beneath on its own, for every run or every page, is not worth its cost to it or to everyone else on the delivery beneath.

**Long-lived caller** means one process for each application, identity and target on one host - a machine, or a browser - holding the one connection to that target and invoking on behalf of the processes it serves; the target is what the application's calls reach, such as one service.\
It is there when the first process needs it and gone when none has needed it for a while, with nothing set up beforehand: on a machine, the first process starts it, two processes starting it at once still leave one, a caller left behind by a crash is replaced, and it ends itself after an idle time the application states, never while it carries an invocation; in a browser, the browser starts it for the first page and ends it after the last, and a call still in flight then ends with it, its ending dropped as a vanished process's is.

**Share** means every short-lived process of one application and identity on one host, calling one target, reaches the same caller.\
Invocations from processes running at once are carried over its one connection at the same time, rather than each process making its own connection or waiting its turn.

**Exactly as if they had called it themselves** means the same four endings a direct call gives, within the bound the short-lived process chose:

- answered;
- refused by the operation, with its reason;
- not delivered - the delivery beneath refused the attempt outright, or the proxy never handed it on, so it had no effect;
- unknown - it may have reached the operation, and no answer came within the bound.

Where a direct call would have given an ending, the process gets that ending unchanged, when it crosses back before the bound passes.\
The extra hop can lose certainty a direct call would have had - the caller stopping, the local channel failing - and then the ending is unknown, never an answer and never not delivered.\
A process that is still there gets exactly one ending, and the bound holds across the hop: the call beneath is given the process's bound less a small allowance for the hop, so an ending it decides at its bound crosses back in time and reaches the process as a direct call's would, up to that allowance early; a hop that stalls past the allowance ends at the bound like a call that was never answered, unknown with the hop's reason.

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

It is embedded by an application that owns its own configuration: what the proxy connects to, under which identity, and, on a machine, how long it waits when idle.

---

## What it is not

**Not the call layer.**\
It does not pair answers with requests to operations, keep the bound on the call beneath, or shape refusals; the call layer beneath does, and its endings reach the process unchanged when they cross back before the bound.\
What the proxy adds is the hop: carrying each invocation to the caller and its ending back, keeping the process's bound across it with a small allowance held back for the hop, and saying unknown where the hop itself loses certainty.

**Not a router, and not a node of its own choosing.**\
It never decides where an operation runs or whether it is reachable.\
It holds the one connection the call layer needs, configured by the application.

**Not a store or a queue.**\
It keeps only the invocations in flight, in memory, and nothing that must survive its own restart.\
It hands each invocation to the call layer as it arrives and keeps no backlog of its own; an invocation in flight when the proxy stops ends, for its process, as unknown.\
An invocation whose process has gone is still finished by the call layer, and its ending is dropped.

**Not a retrier.**\
It never repeats an invocation on its own.\
It carries each invocation's identity unchanged, so whatever owns the effect can recognise a repeat the process makes.

**Not shared between identities.**\
One proxy serves one identity.\
It never carries a process's invocation under another identity, so the operation sees every process of that identity as that one caller, and cannot tell them apart by who is calling.

**Not a network service.**\
It serves processes on its own host, over a channel local to that host, and never listens on the network.\
Which processes may use an identity's proxy is decided by the host's own access rules on that channel.

**Not an authority.**\
It decides nothing about what a caller may do; deciding that is for the operation's host, which sees the proxy's identity.

**Not agentic.**\
It carries calls for agentic systems and contains no cognition, model, or orchestration.

---

## What success means

Four dimensions.\
They are not weighted, and they do not collapse.

**Honest endings.**\
Every invocation through the proxy ends exactly once, within its bound, in the outcome that is true, and every process still there learns that ending.\
The measure is that the proxy stopping or the local channel failing produce more unknowns, and a process vanishing leaves its call finished and its ending dropped - never a hang, a second ending, or an unknown reported as an answer or as not delivered.

**Transparency.**\
Code written for the call layer runs through the proxy unchanged.\
The measure is that the call layer's own guarantee checks, run through the proxy with the hop intact, give the same results as run directly, save that an ending decided at the bound arrives up to the hop's allowance early; where the hop itself fails, the ending is unknown, as honest endings measure.

**Leanness.**\
A short-lived process pays little for the proxy, and the person running it sets nothing up; the application that embeds the proxy supplies its configuration.\
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
