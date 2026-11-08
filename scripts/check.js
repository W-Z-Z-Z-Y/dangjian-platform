const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
let checked = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (file.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      checked++;
    }
    if (file.endsWith('.html')) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (/\bsrc\s*=/.test(match[1]) || !match[2].trim()) continue;
        new vm.Script(match[2], { filename: file });
        checked++;
      }
      for (const match of source.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
        const ref = match[1].split(/[?#]/)[0];
        if (!ref || /^(?:[a-z]+:|\/\/|\$|#)/i.test(ref) || ref.includes('${')) continue;
        if (!fs.existsSync(path.resolve(path.dirname(file), ref))) {
          throw new Error(`缺少页面依赖：${path.relative(root, file)} -> ${ref}`);
        }
      }
    }
  }
}

try { walk(root); console.log(`检查通过：${checked} 个脚本及页面的本地文件引用。`); }
catch (error) { console.error(error.message); process.exitCode = 1; }
