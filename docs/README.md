# Design documents

Read in this order.

| Doc | What it is |
|---|---|
| [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) | D0–D12: the architectural choices (Bun, vanilla scrcpy-server, user-provided `adb`, WebSocket+WebCodecs, single-password auth, no in-app TLS/updates/installer) with the reasoning and costs. |
| [SCRCPY_PROTOCOL.md](SCRCPY_PROTOCOL.md) | scrcpy-server v5.0 wire protocol, derived from upstream source: launch args, tunnels, frame headers, every control/device message byte layout. Authoritative for `src/common/scrcpy.ts` and the stream code. |
| [V1_SCOPE.md](V1_SCOPE.md) | The feature inventory re-cut against the decisions: KEEP / CHANGE / DEFER / DROP per item, with v1.x triggers. |
| [FEATURE_INVENTORY.md](FEATURE_INVENTORY.md) | Behaviour-level inventory of ws-scrcpy-web (the project this one takes inspiration from). Part A condensed, Part B code-level detail with citations into *that* repo. Historical reference; written before the decisions above, so it describes features we later dropped. |

Repo-root `README.md` is the user-facing doc.
