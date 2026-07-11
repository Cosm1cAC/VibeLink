# Rust Workspace Tree Scanner

The workspace tree slice keeps the public workspace APIs in Node and moves bounded directory scanning to the `vibelink workspace-tree` Rust command.

## Rollout

- `VIBELINK_RUST_WORKSPACE_TREE=1` enables the Rust scanner explicitly.
- `VIBELINK_RUST_WORKSPACE_TREE=auto` uses Rust only when the configured command exists.
- `VIBELINK_RUST_WORKSPACE_TREE=0`, an unset flag, a missing command, invalid output, or a command failure uses the Node scanner.
- `VIBELINK_RUST_BIN` overrides the executable. `VIBELINK_RUST_BIN_ARGS_JSON` prepends arguments before `workspace-tree`.
- `VIBELINK_RUST_WORKSPACE_TREE_SESSION=1` enables the persistent `workspace-tree-sidecar`; `auto` uses it when the Rust command is available, and `0` keeps the one-shot Rust CLI path.
- `VIBELINK_RUST_WORKSPACE_TREE_SESSION_TIMEOUT_MS` controls JSONL request timeout. `VIBELINK_WORKSPACE_TREE_SIDECAR_MAX_PENDING_REQUESTS` bounds queued Node requests.

Runtime state is available under `getWorkspaceRuntimeStats().rustWorkspaceTree`. Canary checks should inspect `mode`, `available`, `hits`, `misses`, `fallbacks`, `failures`, `budgetHits`, cache counters, `lastSignature`, `lastError`, and `session` readiness/start/failure/fallback/client counters.

## Contract

The Rust and Node scanners intentionally share these observable rules:

- directories sort before files;
- hidden entries are omitted except `.env`;
- fixed heavy directories such as `.git`, `node_modules`, `dist`, `build`, and `target` are omitted;
- root, nested, and inherited `.gitignore` rules support basename matches, `*`, directory rules, path rules, anchored rules, and negation;
- scans are breadth-first and stop at the requested depth or entry budget;
- paths use `/` separators and item types are `directory` or `file`.

The Rust result includes `truncated` and a metadata signature. Node keeps a bounded in-memory cache keyed by the scanned path, limits, directory metadata, and the content signature of every `.gitignore` visited by the scan. Changes to nested ignore files therefore invalidate cached Rust results.

Node also normalizes an untruncated Rust result with the existing `localeCompare` directory-first breadth-first order before caching it. This preserves the established locale-sensitive workspace API without adding an ICU dependency to the Rust scanner. If Rust reaches its entry budget, Node records a budget fallback and performs the authoritative scan because a differently ordered truncated subset cannot guarantee parity.

## Current Limitations

- The persistent scanner remains canary-only. With session mode off, each uncached request still starts the one-shot CLI; unchanged requests are served from the Node cache in both modes.
- Cache validation still walks the bounded directory shape synchronously in Node before deciding whether the Rust result can be reused. The cache is process-local, bounded by `VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES`, and is cleared on restart.
- The ignore matcher is a deliberate subset, not a complete Git implementation. It does not implement `**`, `?`, character classes, escaped leading `!` or `#`, or every parent-directory re-inclusion edge case. Node fallback and Rust use the same supported subset.
- Windows may impose a one-time executable loading or security-scan delay before the first Rust process. The canary records first-launch latency separately from steady-state uncached scan latency so this remains visible without distorting every cache-miss measurement.

These limitations do not change the fallback contract, but they must remain visible when evaluating latency and compatibility evidence.

## Canary Evidence

Run the local gate with:

```bash
npm run workspace-tree:canary -- --warm-scans 10 --output .tmp/workspace-tree-canary-final.json
```

The representative 2026-07-11 run rebuilt the release binary from the current source and passed all checks. The final post-cache-fix run measured a 60.4ms first launch, 56.6ms steady-state cold scan, and 5.9ms warm p95 across 10 repeated scans. The root scan routed through Rust with `--dir .`, all warm scans hit the cache without another Rust start, and the nested `.gitignore` mutation caused exactly one refresh. Available-command fallback/failure counts and missing-command auto-mode failure/fallback deltas were all zero.

Run the production router against an actual checkout with exact Node/Rust metadata and directory-context parity:

```bash
npm run workspace-tree:real-canary -- --workspace . --paths src,docs --output .tmp/workspace-tree-real-canary.json --delete-temp
```

Two 2026-07-11 VibeLink checkout runs passed with 17 root items, exact `src`/`docs` context parity, 3 Rust routes, 3 warm cache hits, and zero failures/fallbacks. The Node baseline ranged from 53.1ms to 183.6ms, the three process-per-miss Rust cold routes ranged from 642.5ms to 820.4ms total, and the three warm routes ranged from 11.5ms to 16ms.

Additional one-shot runs found and fixed a locale-sensitive ordering gap (`main.py`/`main_debug.py` and localized README names). Two post-fix `ok-wuthering-waves` runs passed exact root plus `src`/`tests` parity across 3 Rust routes at 56.3-62.9ms Node, 152.2-172.9ms Rust cold, and 20.8-23.5ms Rust warm. Two `meetily` runs passed exact root plus `backend`/`frontend`/`docs` parity across 4 Rust routes at 67.7-94.9ms Node, 223.4-228.1ms Rust cold, and 26.4-30.3ms Rust warm. Both had full warm cache reuse and zero failures/fallbacks. These runs isolated process startup as the remaining performance issue, which the persistent sidecar addresses below.

The persistent sidecar removes that process-per-miss penalty while retaining the one-shot Rust and Node fallbacks. Two 2026-07-11 VibeLink runs measured 30.0-31.0ms Node, 53.7-80.3ms Rust cold across 3 scans, and 9.2-10.4ms warm. `ok-wuthering-waves` measured 77.2ms Node, 59.8ms Rust cold across 3 scans, and 15.8ms warm. `meetily` measured 76.1ms Node, 77.1ms Rust cold across 4 scans, and 26.0ms warm. Each run started one sidecar, preserved exact parity and full cache reuse, recorded zero route/session failures or fallbacks, drained pending requests to zero, and terminated cleanly.

`.github/workflows/workspace-tree-rust-canary.yml` rebuilds the release binary on Windows, runs parity/cache tests, executes both the isolated fixture and checkout real-repository canaries, and uploads both JSON results.

Before promoting this slice from `canary` to `default-on`, representative auto-mode runs must continue to show:

- exact Node/Rust path and type parity for the supported fixture matrix;
- zero Rust failures and fallbacks while the command is available;
- missing-command auto mode falls back without recording a Rust failure;
- a repeated unchanged scan produces a Rust cache hit and no additional CLI start;
- nested `.gitignore` changes invalidate the cache and produce the updated result;
- cold and warm latency evidence is captured, with no regression large enough to make the scanner unsuitable for interactive workspace context requests.
- persistent sessions start once, remain ready under normal load, drain pending requests, close cleanly, and fall back first to the one-shot Rust command without changing API results.

Rollback is immediate at two levels: set `VIBELINK_RUST_WORKSPACE_TREE_SESSION=0` to retain the one-shot Rust scanner, or set `VIBELINK_RUST_WORKSPACE_TREE=0` (or unset it) to use Node only.
