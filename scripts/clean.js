/**
 * EMTAC WORKFLOW - clean build artifacts
 * Safe: does NOT delete node_modules or your local DB in Electron userData.
 */
const fs = require('fs');
const path = require('path');

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    console.log('Deleted:', p);
  } catch (e) {
    console.log('Skip:', p, e && e.message ? e.message : e);
  }
}

const root = process.cwd();

// Common build output folders
rmrf(path.join(root, 'dist'));
rmrf(path.join(root, 'out'));
rmrf(path.join(root, 'build', 'tmp'));
rmrf(path.join(root, '.electron-builder'));

// Optional caches (safe)
rmrf(path.join(root, '.cache'));
rmrf(path.join(root, 'tmp'));

console.log('Clean complete.');
