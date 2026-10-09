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
