const fs = require('fs');
const ts = require('typescript');
const code = fs.readFileSync('src/webviewContent.ts', 'utf8');
const js = ts.transpile(code);
fs.writeFileSync('temp.js', js);
const { getWebviewContent } = require('./temp.js');
const html = getWebviewContent();
const match = html.match(/<script>(.*?)<\/script>/s);
if (!match) { console.error("No script tag found"); process.exit(1); }
const script = match[1];
fs.writeFileSync('test_script.js', 'function acquireVsCodeApi(){return{postMessage:()=>null};}\n'+script);
console.log("Script extracted successfully.");
