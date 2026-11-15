#!/usr/bin/env node
import { runCcStatusline } from './cc-statusline-lib.js';

runCcStatusline(process.argv.slice(2), { stdin: process.stdin, env: process.env }).then(
  (code) => process.exit(code),
  () => process.exit(0),
);
