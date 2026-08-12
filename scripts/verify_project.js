const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const required = [
  'package.json',
  'src/main.js',
  'src/preload.js',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/app.js',
  'r/pipeline.R',
  'r/check_environment.R',
  '.github/workflows/build-windows.yml'
];

let failed = false;

for (const rel of required) {
  const full = path.join(root, rel);
  const ok = fs.existsSync(full) && fs.statSync(full).isFile() && fs.statSync(full).size > 0;
  console.log(`${ok ? 'OK' : 'MISSING'}  ${rel}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('Project verification FAILED.');
  process.exit(1);
}

console.log('Project verification PASSED.');
