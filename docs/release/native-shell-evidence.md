# Native Win32 Shell Evidence

Date: 2026-07-26

## Scope

The default Windows user entry now opens a raw Win32 tray/admin window through `windows-sys`. It does not load WebView2, Tauri, Electron, HTML, or the console QR surface. The window exposes pairing, status refresh, diagnostics, settings, update checks, compatibility rollback, and explicit exit.

The supervised bridge starts behind a file gate, joins a kill-on-close Windows Job Object, and only then starts its descendants. Exit and compatibility rollback terminate the whole Job before continuing.

## Verification

- Full Rust suite: 183 passed, 0 failed, 1 pre-existing ignored.
- `cargo clippy -- -D warnings`: passed.
- Native lifecycle smoke: root exit code 0; four descendant PIDs removed; external listener removed.
- Isolated pairing/rollback smoke: one pairing row created; after rollback the public listener owner changed to `node`; final listener removed; root exit code 0.
- Native status and doctor actions use the same in-process Rust snapshot builders as the authenticated HTTP routes, without creating a launcher authentication bypass.
- UI Automation inspection before the final font/DPI adjustment exposed every visible command as a standard Win32 button and found no overlap. The final visual re-capture was stopped by physical Escape and is not claimed as current screenshot evidence.

## Memory

`Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate` was sampled from the native GUI root process:

| Mode | Peak private working set | Exit | Listener after exit |
| --- | ---: | ---: | --- |
| Idle | 1.69 MiB | 0 | none |
| Status + doctor action | 1.80 MiB | 0 | none |

The same samples reported approximately 15-18 MiB total working set and 2.4-2.5 MiB private bytes. No embedded browser process was present.

## Phase 5 Gate Status

- Native Win32 tray/admin entry: passed.
- 3,600-second real whisper weak-network Live Call run: passed.
- Physical Android microphone, notification, and disconnect recovery: passed.

## Rust Live Call Evidence

`tools/release/run-live-call-evidence.mjs` now starts the Rust-only HTTP front door and Rust execution daemon. It no longer starts `src/server.js` or selects mock ASR. The harness records SSE reconnect replay, SQLite event/task projection state, runtime pending questions, PCM/checkpoint byte inventories, child-process ownership, listener shutdown, and a Windows rename probe that fails if recording handles remain open.

A 20-second weak-network speech canary on 2026-07-26 passed with real `whisper-cli.exe` and `ggml-base.bin`: SSE replay 14/14, PCM 154,240/154,240 bytes, zero-byte recovered checkpoint, no duplicate event IDs, zero pending questions/projections, no Node descendants, and released listener/file handles. The canary also exposed and fixed two Windows-specific ASR defects: whisper crashed on absolute paths containing non-ASCII characters, and append-only checkpoint handles could not be truncated after successful transcription.

The speech input was Windows TTS rendered as 16 kHz mono PCM. It validates the native whisper/VAD/process and question-dispatch path, but it is not physical-microphone evidence and is not presented as such.

The archived one-hour run is `.tmp/release-evidence/live-call/2026-07-26T04-27-48-242Z/evidence.json`. It completed 43,471 stress ticks with 39 weak-network reconnects, accepted and retained exactly 26,421,760 PCM bytes, persisted 1,016 contiguous events with zero duplicate event IDs, drained all pending questions and task projections, left a zero-byte ASR checkpoint, spawned no Node descendants, and released the listener and recording handles. The run used the real native whisper binary and base model. It preceded the final connection-reuse and expected-client-disconnect log cleanup, so its historical execd/frontdoor stderr is retained rather than described as clean.

The final-code 100-second canary is `.tmp/release-evidence/live-call/2026-07-26T06-17-11-617Z/evidence.json`. It forced one reconnect, replayed 37/37 SSE events, kept SQLite cursors contiguous with zero duplicate IDs, drained all pending work, retained 736,640/736,640 PCM bytes, reset the checkpoint to zero, released all handles, and produced zero-byte bridge and execd stderr logs.

## Physical Android Evidence

The opt-in `LiveCallPhysicalDeviceTest` ran on a physical PJX110 with Android 16 (SDK 36). It starts the real foreground audio service, asserts the active Live Call notification, records PCM through `AudioRecord`, has the device-local WebSocket peer initiate a close, waits for the production reconnect path, confirms more PCM after recovery, stops the service, asserts notification removal, and deletes the retained recording to prove its file handle was released.

The passing device run completed in 2.43 seconds and reported `initialBytes=3200` and `recoveredBytes=3200`. Device package state showed `RECORD_AUDIO` and `POST_NOTIFICATIONS` granted, the `vibelink_live_call` notification channel registered, and no VibeLink process in the device crash list. The first physical run exposed a real client bug: peer-initiated WebSocket close entered `onClosing` but never reached `onClosed`, so reconnect was not scheduled. `LiveCallAudioStreamer` now acknowledges `onClosing` and immediately enters the existing bounded recovery path; the same physical test passed after the fix.
