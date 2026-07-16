# VibeLink Product Capability Roadmap

## Scope

Incrementally add unified search, thread tags/favorites, a global command palette, and a PR review workflow across the HTTP bridge and Android client.

## Ordered Tasks

1. Unified search: `/api/search?q=&scope=&limit=&cursor=&fields=` across sessions, tasks, history messages, and Workspace files; Android loading/empty/error/result navigation.
2. Tags and favorites: persist `tags` and `favorite` in thread state, add filtering, sorting, and batch updates; expose Android editing and filters.
3. Global command palette: consolidate navigation, search, session creation, refresh, favorites, Workspace, and approval actions behind one permission-aware registry.
4. PR review: define review contracts and APIs for sessions, diffs, comments, severity, and status; add Android selection, diff, comment, resume, and jump flows.
5. Integration: wire navigation and details, add end-to-end coverage, run server tests, Android unit tests, Android build, and manual device checks.

## Verification Checkpoints

- Each numbered step gets an independent commit after focused tests pass.
- Search must return all four content categories and support cursor pagination and field projection.
- Thread metadata must survive process restart and be visible to a second client.
- Dangerous command-palette and review actions must reuse approval policy.
- Final checkpoint requires server tests, Android unit tests/build, and end-to-end navigation coverage.

