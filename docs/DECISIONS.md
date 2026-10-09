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
