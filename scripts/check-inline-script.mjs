// Compiles the inline script blocks of an HTML file so a broken renderer
// script is reported as a syntax error instead of a silent runtime failure.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || 'index.html');
const html = readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
if (!blocks.length) {
  console.error('No inline script found in ' + file);
  process.exit(1);
}
let failed = 0;
blocks.forEach((match, index) => {
  const code = match[1];
  try {
    // eslint-disable-next-line no-new-func
    new Function(code);
    console.log('inline script block ' + (index + 1) + ' compiles');
  } catch (error) {
    failed += 1;
    console.error('inline script block ' + (index + 1) + ' failed: ' + error.message);
  }
});
process.exit(failed ? 1 : 0);
