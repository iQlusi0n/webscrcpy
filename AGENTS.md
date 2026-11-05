# Instructions for coding agents

Read `docs/ARCHITECTURE.md` before editing anything; it holds the layout, slice contracts, invariants and the enforced project rules. `docs/DESIGN_DECISIONS.md` explains why things are the way they are — do not reintroduce what it rules out (native addons, runtime downloads, in-app TLS, updater, user accounts, Windows).

Before finishing any change: `bun run check` (Biome + tsc + tests) must pass, and `bun run build` must produce `dist/webscrcpy`. Device-path changes cannot be unit-verified here; say so explicitly and list what to smoke on a phone (see ARCHITECTURE.md §6).

Device wire protocol is `docs/SCRCPY_PROTOCOL.md`; when in doubt, upstream scrcpy v5.0 source wins over any comment in this repo.
