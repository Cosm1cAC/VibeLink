# Doubao / 豆包

Doubao uses `doubao-cli` with a Chrome extension bridge. It reuses the user's existing `doubao.com` browser login state and does not require `--remote-debugging-port`.

For a one-shot setup, when the user says "帮我配豆包", run:

```bash
doubao configure --json
```

Then follow the returned `nextActions`. Chrome requires one manual security step: load the unpacked extension path returned as `extension.path`.

Run diagnosis:

```bash
doubao doctor --json
```

If the bridge is offline, start it:

```bash
doubao daemon run --json
```

Ask:

```bash
doubao ask "写一个摘要" --json
echo "写一个摘要" | doubao ask --stdin --json
```

Requires Chrome or Edge to be running with the Doubao Bridge extension installed and a logged-in `doubao.com` session.
