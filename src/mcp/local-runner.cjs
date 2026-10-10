#!/usr/bin/env node
'use strict';
// Legacy host registrations can use this file; all new registrations use recruiters mcp.
const { pathToFileURL } = require('node:url');
const path = require('node:path');
process.argv.splice(2, 0, 'mcp');
import(pathToFileURL(path.resolve(__dirname, '../../bin/recruiters.mjs')).href);
