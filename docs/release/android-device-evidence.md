# Android Physical Device Evidence

Release evidence must contain one real phone and one real tablet run. Emulator output is retained as connected-device regression evidence, but it does not satisfy this gate.

Each device archive must include:

- `logcat.txt` captured after the run.
- Screenshots for the device overview and every required scenario.
- A manifest entry with model, Android version, and a non-reversible `serialHash`.

Required scenarios:

1. Browser remote control: connect to a real Bridge, navigate, screenshot, and verify a trace event.
2. Artifact workbench: preview/edit a CSV, reject a corrupt artifact, rotate the device, and load a large bounded document.
3. Approval decision: receive a real approval and exercise accept and deny paths.
4. Live Call ASR/microphone: grant microphone permission, capture audio/transcript/QA evidence, and include the provider and failure status.
5. Notification permission: exercise the Android 13+ permission flow and record the resulting token/permission state without secrets.
6. Rotation: complete the above state-preserving checks across portrait and landscape.

Validate an archive before release:

```powershell
npm run release:android-device-evidence -- --manifest .\android-physical\manifest.json
```

The `release-quality-evidence` workflow exposes a manual physical-device gate. Set `require_physical_android=true` and provide an HTTPS manifest URL; the job downloads the archive manifest and fails unless both form factors and all required scenario artifacts are present.
