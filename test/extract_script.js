const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Resolve both input and output from this script, independent of the shell cwd.
const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'src', 'ui', 'webviewContent.ts');
const cache = new Map();
function loadTsModule(filePath) {
    const resolved = fs.existsSync(filePath) ? filePath : `${filePath}.ts`;
    if (cache.has(resolved)) { return cache.get(resolved).exports; }
    const compiled = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText;
    const mod = { exports: {} };
    cache.set(resolved, mod);
    const localRequire = specifier => specifier.startsWith('.')
        ? loadTsModule(path.resolve(path.dirname(resolved), specifier))
        : require(specifier);
    vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require: localRequire }, { filename: resolved });
    return mod.exports;
}
const html = loadTsModule(sourcePath).getWebviewContent(key => key);
const match = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i);
if (!match) { throw new Error('No inline Webview script found'); }

// Parse the actual generated JavaScript without executing browser operations.
new vm.Script(match[1], { filename: 'webview-script.js' });
const outputPath = path.join(root, 'out', 'webview-script.js');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, match[1], 'utf8');
console.log('Webview script extracted and syntax verified.');
