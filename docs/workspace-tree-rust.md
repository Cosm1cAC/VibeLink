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

These limitations do not change the fallback contract, but they must remain visible when evaluating latency and compatibility evidence.

## Canary Gate

Before promoting this slice from `opt-in` to `canary`, representative auto-mode runs must show:

- exact Node/Rust path and type parity for the supported fixture matrix;
- zero Rust failures and fallbacks while the command is available;
- missing-command auto mode falls back without recording a Rust failure;
- a repeated unchanged scan produces a Rust cache hit and no additional CLI start;
- nested `.gitignore` changes invalidate the cache and produce the updated result;
- cold and warm latency evidence is captured, with no regression large enough to make the scanner unsuitable for interactive workspace context requests.

Rollback is immediate: set `VIBELINK_RUST_WORKSPACE_TREE=0` or unset the flag.
