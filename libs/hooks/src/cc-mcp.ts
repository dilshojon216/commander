#!/usr/bin/env node
import { runMcpServer } from './cc-mcp-lib.js';

runMcpServer({ stdin: process.stdin, stdout: process.stdout, env: process.env, cwd: process.cwd() }).then(
  () => process.exit(0),
  (err: unknown) => {
    process.stderr.write(`cc-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
