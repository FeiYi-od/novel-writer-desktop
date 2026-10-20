import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

// Report names and rule IDs only: never print matched credentials or addresses.
const rules = [
  { id: 'api-key', expression: /\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[opsu]_[a-zA-Z0-9_]{25,})\b/u },
  { id: 'private-ipv4', expression: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/u },
  { id: 'personal-home', expression: /[a-zA-Z]:[\\/]Users[\\/](?!Public(?:[\\/]|\b)|Default(?:[\\/]|\b))[^\\/\s"']+/iu },
  { id: 'private-key', expression: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u }
];
const findings: { file: string; rule: string }[] = [];
const inspect = (file: string, bytes: Buffer) => {
  const text = bytes.toString('utf8');
  for (const rule of rules) if (rule.expression.test(text)) findings.push({ file, rule: rule.id });
};
async function main() {
const root = path.resolve(process.argv[2] ?? 'out');
if (root.endsWith('.asar')) {
  const require = createRequire(import.meta.url);
  const builder = require.resolve('electron-builder');
  const asar = require(require.resolve('@electron/asar', { paths: [path.dirname(require.resolve('app-builder-lib', { paths: [path.dirname(builder)] }))] })) as {
    listPackage(archive: string): string[]; extractFile(archive: string, file: string): Buffer;
  };
  const names = asar.listPackage(root).map(name => name.replace(/^[\\/]/u, '').replace(/\\/gu, '/'));
  const allowedTop = new Set(['out', 'node_modules', 'package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs']);
  for (const name of names) {
    if (!allowedTop.has(name.split('/')[0]!)) findings.push({ file: name, rule: 'unexpected-bundled-path' });
    if (name.startsWith('docs/') && name !== 'docs/licenses' && name !== 'docs/licenses/ASTRBOT_AGPL-3.0.txt') findings.push({ file: name, rule: 'private-document' });
    if (/^out\/.*\.(?:js|html|css|json)$/u.test(name) || name === 'package.json') inspect(name, asar.extractFile(root, name.split('/').join(path.sep)));
  }
  console.log(JSON.stringify({ target: 'app.asar', entries: names.length, findings }, null, 2));
} else {
  async function visit(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Release input must not contain symbolic links');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:ts|tsx|js|html|css|json)$/u.test(entry.name)) inspect(path.relative(root, file), await fs.readFile(file));
    }
  }
  await visit(root);
  console.log(JSON.stringify({ target: path.basename(root), findings }, null, 2));
}
if (findings.length) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Release privacy check failed'); process.exitCode = 1; });
