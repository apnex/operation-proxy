# operation-proxy

Let short-lived processes invoke named operations through one long-lived caller they share, each invocation still ending honestly.

**Status: built, and certified at zorg's Delta 1, stage 4a, at `1d3d127`.**\
Its vision is ratified (zorg's `D50`), and its contract's design is certified at zorg's Delta 1, stage 0.\
Its contract tests run operation-call's caller suite through the client half, and the proxy's own cases over real Unix domain sockets, abstract-namespace sockets and child processes, so they run on Linux only.\
`npm test` also compiles `test/types/caller-interface-parity.ts`, a strict consumer of operation-call's caller interface, which passes when it compiles: it accepts operation-call's caller and the client half unchanged (zorg's `EM12`).

- `VISION.md` - why it exists, and what it will never be.
- `CONTRACT.md` - what a consumer can depend on, one capability per row.
- `docs/DECISIONS.md` - the rulings about this component.

It belongs to a component set first composed by zorg (`apnex/zorg`), and is private until its first working code.

It depends on `@apnex/operation-call` through a `file:` link to a checkout beside it, and its tests on `@agp/core`, `@agp/node` and `@agp/transport-loopback` the same way.\
Each checkout must be installed and built first, since no `dist/` is committed.\
The tests create `.operation-proxy` in the home directory the user database records, as every proxy of the user does, and leave its `secret` there.

To run the tests from clean checkouts:
```sh
(cd ../agp && npm ci && npm run build)
(cd ../shape-check && npm ci && npm run build)
(cd ../operation-call && npm ci && npm run build)
npm install
npm test
```
