import { writeFileSync } from 'node:fs';

// dist/cjs holds the CommonJS build; this marker makes Node load its .js files as CommonJS
// even though the package itself is "type": "module".
writeFileSync('dist/cjs/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
