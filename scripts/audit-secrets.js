'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const findings = [];
const patterns = [/giggy_sk_[A-Za-z0-9_-]{16,}/, /\bsk-[A-Za-z0-9_-]{24,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bAIza[A-Za-z0-9_-]{30,}/,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{30,}/];
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'coverage'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name), relative = path.relative(root, file);
    if (entry.isDirectory()) { scan(file); continue; }
    if ((/^\.env(?:\.|$)/.test(entry.name) && entry.name !== '.env.example') || /\.(?:pem|key|zip|log)$/.test(entry.name)) { findings.push(relative); continue; }
    if (/\.(?:webp|png|jpg)$/.test(entry.name)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (patterns.some(pattern => pattern.test(text))) findings.push(relative);
  }
}
scan(root);
if (findings.length) { console.error('Potential secrets or private files found (values withheld):\n' + findings.join('\n')); process.exitCode = 1; }
else console.log('Public files passed the credential-pattern and private-file scan.');
