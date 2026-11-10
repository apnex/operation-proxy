# Decisions

One ruling per entry, append-only.\
A ruling is never edited; a later one supersedes it and says so.

Rulings that shape this component together with others are held in zorg's `docs/DECISIONS.md`, and cited here as "zorg's `Dn`".

---

## D1 - The component stands in its own repository

**Ruled by:** the director, 2026-10-09 (zorg's `D28` and `D29`).\
**Affects:** this repository.

**Ruling.**\
This component, operation-relay, is sovereign and stands in its own repository, private until its first working code, on the terms of zorg's `D16`.\
Its contract of record is `CONTRACT.md` (zorg's `D17`), and its vision becomes enduring only when the director ratifies it.

**Why.**\
The commands of zorg need one long-lived caller per identity rather than a node for each command (zorg's `D28`), and that mechanism holds nothing specific to zorg (zorg's `D29`).

---

## D2 - Renamed operation-proxy

**Ruled by:** the director, 2026-10-09 (zorg's `D30`).\
**Affects:** this repository, its package, `VISION.md`, `CONTRACT.md` and `README.md`.

**Ruling.**\
The component formerly named operation-relay is named operation-proxy, and its long-lived process is a proxy; its repository is `apnex/operation-proxy`, and GitHub redirects the old name.\
Its draft capabilities are renamed with it: `proxied-invocation`, `proxy-on-demand`, `proxy-idle-expiry` and `one-identity-per-proxy`.\
Earlier entries keep the name they were written with.

**Why.**\
The hub sees the long-lived process as the caller, acting for the short-lived processes it serves, which is what a proxy does; the client half is a remote proxy in the classic sense.\
"Relay" is AGP's word for passing delivery reports from hop to hop, a different idea.

---

## D3 - One proxy for each application, identity and target

**Ruled by:** the director, 2026-10-10 (zorg's `D34`).\
**Affects:** `VISION.md` (*Long-lived caller*, *Share*), `CONTRACT.md` (`PX1`, `one-identity-per-proxy`, `proxy-on-demand`).

**Ruling.**\
A proxy serves one application, identity and target, the target being what the application's calls reach; for zorg, a hub named by its URL and node.

**Why.**\
Two targets are two services, each needing its own connection, and refusing one while a proxy serves the other would leave the caller nothing to act on.


---

## D4 - A proxied call's bound holds back a hop allowance

**Ruled by:** the director, 2026-10-11 (zorg's `D45`).\
**Affects:** `CONTRACT.md` - the `proxied-invocation` row, `PX5`, `PX6`, `PX8`, `PX9` and `PX10`.

**Ruling.**\
The client half keeps its caller's bound and gives the proxy's call a bound that ends a hop allowance sooner - the application's allowance, by default 50 milliseconds, or half the bound if that is less - so a call that runs out its bound through a working hop ends as a direct call does, `bound-passed` with its delivery report, and `hop-stalled` means a hop that held the ending past the allowance.

**Why.**\
Giving the proxy's call the caller's whole bound made every proxied call that ran out its bound end `hop-stalled` with no delivery report, since the proxy's ending could only cross the hop after the client half's own bound had passed; the delivery report is what tells a caller of an operation that recognises no repeat whether to repeat it.

**Alternatives weighed.**\
Accepting the exception as written; forwarding each delivery report across the hop, which keeps the report but still reports `hop-stalled` on every timeout.

**Named costs.**\
The operation gets the allowance less time than the caller's bound, a call that runs out its bound reports its ending up to the allowance early, and the application chooses an allowance for its hop.

---

## D5 - A proxied invocation ends as the same invocation made directly with the shorter bound

**Ruled by:** the director, 2026-10-11 (zorg's `D46`, amending `D45` and this component's `D4`).\
**Affects:** `CONTRACT.md` - the `proxied-invocation` row, `PX5`, `PX6`, `PX8` and `PX10`; `VISION.md`.

**Ruling.**\
An invocation with bound B through the proxy ends exactly as the same invocation made directly with a bound ending a hop allowance before B, and that ending reaches the process before B whenever the hop carries it back within the allowance; otherwise it ends `unknown` with `hop-stalled`.\
The proxy rounds its call's bound down, so the margin is never less than the allowance; an allowance of 0, or a bound of 1 millisecond, leaves no margin; and in a browser the page sends the time remaining, not a moment on its own clock.

**Why.**\
`D4` said a proxied call ends as a direct one does, up to the allowance early, which holds only for the timeout: shortening the call beneath also loses any answer, refusal, abort or delivery report that falls in the last allowance of the bound, and the earlier rounding up spent part of the margin; stated as one rule, every consequence follows from it and a test can check it by running the same invocation directly with the shorter bound.

---

## D6 - A proxied invocation ends as the direct call the proxy makes for it

**Ruled by:** the director, 2026-10-11 (zorg's `D48`, amending `D46` and this component's `D5`).\
**Affects:** `CONTRACT.md` - the `proxied-invocation` row, `PX5`, `PX6`, `PX8` and `PX10`; `VISION.md`.

**Ruling.**\
An invocation through the proxy ends exactly as the direct call the proxy makes for it: made when the proxy hands it on, with the abort as the proxy relays it, and with a bound ending a hop allowance before the client half's deadline - in a browser, the time remaining at posting less the allowance, counted from receipt; that ending reaches the process before its deadline whenever the return transit, and in a browser the outbound transit with it, takes less than the allowance, and otherwise the invocation ends `unknown` with `hop-stalled`.\
The exported caller suite holds the cases of a working hop; the held and stopped hops are this component's own cases.

**Why.**\
No protocol of the proxy's can make its call match a direct call made by the process: the outbound transit starts it later, an abort crossing the hop during admission can arrive after admission, and a browser's remaining time restarts at receipt; the direct call the proxy makes is the one that exists, so the rule holds by construction and a test checks it against that call.

---

## D7 - The vision is ratified

**Ruled by:** the director, 2026-10-11 (zorg's `D50`).\
**Affects:** `VISION.md`.

**Ruling.**\
The vision is ratified at `439ba68`, after three rounds of cold reading by three model families and the absorption of zorg's `D45`, `D46` and `D48`, and its status line says so.\
From here it changes only by a recorded decision, absorbed into it.

---

## D8 - The first release, 0.1.0, carrying the five shared fixes

**Ruled by:** the director, 2026-11-10 (draw's `H31-5`, on zorg's agreement: draw's request, `upstream/drawv2-shared-component-fixes-request.md`, and zorg's reply, `upstream/drawv2-shared-component-fixes-reply.md`, whose answers bind).\
**Affects:** `package.json` and its lockfile, `.nvmrc`, `.github/workflows/gate.yml` and `release.yml`, `tools/consumer-test.mjs`, `CONTRACT.md`'s frontmatter and Reference, and `README.md`; nothing in `src/`, and nothing the component does.

**Ruling.**\
The five fixes every consumer of the components zorg maintains needs, made by draw's builders on zorg's agreement, none changing what the component does:
1. A release in the pinned-file form, gated by CI: `gate.yml` runs `npm test` and `npm run docs:check` on every push and pull request on Node 22 and 24, then the consumer test on Node 22 -- the package packed, installed into an empty project with `--omit=dev`, no AGP package installed, and every export imported by name; `release.yml`, on a tag `v<version>` that the repository's `release tags` ruleset protects, runs the gate, packs the package once, attaches the `.tgz` and its `.sha512` to a draft GitHub release, downloads both back and compares them, and only then publishes, immutable releases being enabled for the repository before its first tag; the first release is `0.1.0`.
2. A Node 22 floor: `engines` `>=22.13`, for `node:sqlite`, which loads without a flag from Node 22.13, and `.nvmrc` `22`.
3. Dependencies between components as release files: `@apnex/operation-call` and `@apnex/shape-check` from `file:` links to their `0.1.0` release files, each pinned in the lockfile by its integrity.
4. AGP declared as what it is: unchanged: AGP's packages were already development dependencies, `file:` links to an AGP checkout.
5. The contract's frontmatter brought to mission-kit's: `id: C8`, `status: active`, and the sentences that said the id was unminted and the repository private until its first working code restated.

**Choices made at build.**
- `private: true` stays: it stops publishing to the npm registry, and `npm pack` packs the package with it.
- The style rules `npm run docs:check` holds are vendored in `tools/`, so CI fetches no mission-kit checkout.
- In CI this repository is checked out into a folder of its own and `apnex/agp` beside it, both inside the workspace, since `actions/checkout` places a repository only there; AGP is checked out with its history and then at `b179b4f` by that short id, so no full commit id is written but the actions' own pins, and built with `npm --prefix ../agp ci && npm --prefix ../agp run build` before `npm ci`, so the `file:` links to `../agp/packages` resolve (zorg's answer 3).
- Its contract builds a browser adapter (`PX8`) and says `@apnex/operation-proxy` and `@apnex/operation-proxy/browser` run in a browser, so the consumer test also loads both in headless Chrome through an import map of the installed packages, every export imported by name, with `@apnex/headless-chromium` `0.2.0` as a development dependency pinned to its release file; `@apnex/operation-proxy/machine`, the Linux adapter, is imported in Node alone.

**Why.**\
Draw takes components as public GitHub release files pinned by hash and runs Node 22 in production (draw's `H26-2`); a `file:` link builds only beside a checkout, and an AGP declared for install would make every consumer install it though every import of it is a type.
