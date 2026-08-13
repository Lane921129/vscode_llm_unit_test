const fs = require('fs');
const file = 'src/webviewContent.ts';
let content = fs.readFileSync(file, 'utf8');
content = content.replace(/\\\$\{t\(/g, '${t(');
fs.writeFileSync(file, content);
