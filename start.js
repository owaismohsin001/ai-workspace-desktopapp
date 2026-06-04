'use strict';

// Launcher wrapper: deletes ELECTRON_RUN_AS_NODE from the environment
// before spawning the Electron binary.
//
// Claude Code (and VS Code) set ELECTRON_RUN_AS_NODE=1 in their shell so
// they can use the Electron binary as a plain Node.js runtime. Any npm
// script launched from those shells inherits that variable, which causes
// Electron to start in Node.js mode instead of browser mode — no window,
// no app API. Explicitly removing it here fixes the launch without requiring
// the user to change their system environment.

const { spawn } = require('child_process');
const electronBin = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, ['.'], {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('close', (code, signal) => {
  if (code === null) {
    console.error('Electron exited with signal', signal);
    process.exit(1);
  }
  process.exit(code);
});
