# Rust Workspace Tree Scanner

The workspace tree slice keeps the public workspace APIs in Node and moves bounded directory scanning to the `vibelink workspace-tree` Rust command.

## Rollout

- `VIBELINK_RUST_WORKSPACE_TREE=1` enables the Rust scanner explicitly.
- `VIBELINK_RUST_WORKSPACE_TREE=auto` uses Rust only when the configured command exists.
- `VIBELINK_RUST_WORKSPACE_TREE=0`, an unset flag, a missing command, invalid output, or a command failure uses the Node scanner.
- `VIBELINK_RUST_BIN` overrides the executable. `VIBELINK_RUST_BIN_ARGS_JSON` prepends arguments before `workspace-tree`.

Runtime state is available under `getWorkspaceRuntimeStats().rustWorkspaceTree`. Canary checks should inspect `mode`, `available`, `hits`, `misses`, `fallbacks`, `failures`, `budgetHits`, cache counters, `lastSignature`, and `lastError`.

## Contract

The Rust and Node scanners intentionally share these observable rules:

- directories sort before files;
- hidden entries are omitted except `.env`;
- fixed heavy directories such as `.git`, `node_modules`, `dist`, `build`, and `target` are omitted;
- root, nested, and inherited `.gitignore` rules support basename matches, `*`, directory rules, path rules, anchored rules, and negation;
- scans are breadth-first and stop at the requested depth or entry budget;
- paths use `/` separators and item types are `directory` or `file`.

The Rust result includes `truncated` and a metadata signature. Node keeps a bounded in-memory cache keyed by the scanned path, limits, directory metadata, and the content signature of every `.gitignore` visited by the scan. Changes to nested ignore files therefore invalidate cached Rust results.

## Current Limitations

- This is not yet a long-lived Rust scanner. Each uncached request starts the CLI; unchanged requests are served from the Node cache.
- Cache validation still walks the bounded directory shape synchronously in Node before deciding whether the Rust result can be reused. The cache is process-local, bounded by `VIBELINK_WORKSPACE_TREE_CACHE_MAX_ENTRIES`, and is cleared on restart.
- The ignore matcher is a deliberate subset, not a complete Git implementation. It does not implement `**`, `?`, character classes, escaped leading `!` or `#`, or every parent-directory re-inclusion edge case. Node fallback and Rust use the same supported subset.
- Windows may impose a one-time executable loading or security-scan delay before the first Rust process. The canary records first-launch latency separately from steady-state uncached scan latency so this remains visible without distorting every cache-miss measurement.

These limitations do not change the fallback contract, but they must remain visible when evaluating latency and compatibility evidence.

## Canary Evidence

Run the local gate with:

```bash
npm run workspace-tree:canary -- --warm-scans 10 --output .tmp/workspace-tree-canary-final.json
```

The representative 2026-07-11 run rebuilt the release binary from the current source and passed all checks. It measured a 34.3ms first launch, 31.8ms steady-state cold scan, and 3.3ms warm p95 across 10 repeated scans. The root scan routed through Rust with `--dir .`, all warm scans hit the cache without another Rust start, and the nested `.gitignore` mutation caused exactly one refresh. Available-command fallback/failure counts and missing-command auto-mode failure/fallback deltas were all zero.

`.github/workflows/workspace-tree-rust-canary.yml` rebuilds the release binary on Windows, runs parity/cache tests, executes the same representative canary, and uploads `.tmp/workspace-tree-canary-ci.json`.

Before promoting this slice from `canary` to `default-on`, representative auto-mode runs must continue to show:

- exact Node/Rust path and type parity for the supported fixture matrix;
- zero Rust failures and fallbacks while the command is available;
- missing-command auto mode falls back without recording a Rust failure;
- a repeated unchanged scan produces a Rust cache hit and no additional CLI start;
- nested `.gitignore` changes invalidate the cache and produce the updated result;
- cold and warm latency evidence is captured, with no regression large enough to make the scanner unsuitable for interactive workspace context requests.

Rollback is immediate: set `VIBELINK_RUST_WORKSPACE_TREE=0` or unset the flag.
