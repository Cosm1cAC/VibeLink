const delay = Number(process.env.VIBELINK_FAKE_PROVIDER_DELAY_MS || 2500);

process.stdout.write(`${JSON.stringify({ type: "assistant", text: "started" })}\n`);
await new Promise((resolve) => setTimeout(resolve, delay));
process.stdout.write(`${JSON.stringify({ type: "result", text: "completed" })}\n`);
