#!/usr/bin/env node
import { runDoubaoCli } from "../lib/cli.mjs";

process.exitCode = await runDoubaoCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env
});
