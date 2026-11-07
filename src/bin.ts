#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    process.stderr.write((e.stack ?? e.message) + '\n');
    process.exitCode = 2;
  },
);
