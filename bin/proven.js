#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main();
process.exitCode = code;
// Never hang after the work is done.
setTimeout(() => process.exit(code), 2000).unref();
