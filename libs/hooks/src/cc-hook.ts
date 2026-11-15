#!/usr/bin/env node
import { runCcHook } from './cc-hook-lib.js';

runCcHook(process.argv.slice(2), { stdin: process.stdin, stdout: process.stdout, env: process.env }).then(
  () => process.exit(0),
  () => process.exit(0),
);
