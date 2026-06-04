'use strict';
// Preflight check — MUST use only ES5 syntax so this runs on any Node.js version.
// Validates Node.js >= 18 before loading the ESM entry point (which uses ES2020+ syntax).
var _nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (_nodeMajor < 18) {
  console.error(
    'ERROR: @aico-bot/remote-agent-proxy requires Node.js >= 18.0.0.' +
    '\n  Current version: ' + process.version +
    '\n  Please upgrade Node.js: https://nodejs.org/' +
    '\n  (If deploying via AICO-Bot, use the offline bundle which ships its own Node.js.)'
  );
  process.exit(1);
}

import('./dist/index.js').catch(function(err) {
  console.error('Failed to start server:', err);
  process.exit(1);
});
