import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export interface FunctionAstInfo {
    name: string;
    fullName: string;      // 例如 "MyClass.calculate_total" 或 "standalone_func"
    className: string | null;
    isAsync: boolean;
    args: string[];
}

/**
 * 透過 Python 原生 AST 完整解析檔案內所有函式、Class Method、Async 函式
 */
export async function extractFunctionsWithAst(filePath: string): Promise<FunctionAstInfo[]> {
    if (!fs.existsSync(filePath)) return [];

    const pythonScript = `
import sys, ast, json

class FunctionVisitor(ast.NodeVisitor):
    def __init__(self):
        self.functions = []
        self.scope_stack = []

    def visit_ClassDef(self, node):
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def _process_func(self, node, is_async=False):
        # 排除 dunder 與 test 方法
        if node.name.startswith('__') and node.name.endswith('__'):
            return
        if node.name.startswith('test_'):
            return

        class_name = self.scope_stack[-1] if self.scope_stack else None
        full_name = f"{class_name}.{node.name}" if class_name else node.name
        
        args = [arg.arg for arg in node.args.args if arg.arg != 'self']
        self.functions.append({
            'name': node.name,
            'fullName': full_name,
            'className': class_name,
            'isAsync': is_async,
            'args': args
        })

    def visit_FunctionDef(self, node):
        self._process_func(node, is_async=False)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        self._process_func(node, is_async=True)
        self.generic_visit(node)

try:
    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        tree = ast.parse(f.read(), filename=sys.argv[1])
    visitor = FunctionVisitor()
    visitor.visit(tree)
    print(json.dumps(visitor.functions, ensure_ascii=False))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`;

    return new Promise((resolve) => {
        const py = spawn('python', ['-c', pythonScript, filePath], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
        });

        let stdout = '';
        py.stdout.on('data', data => stdout += data.toString());
        py.on('close', code => {
            if (code === 0 && stdout.trim()) {
                try {
                    resolve(JSON.parse(stdout));
                } catch {
                    resolve([]);
                }
            } else {
                resolve([]);
            }
        });
    });
}

/** 遞迴掃描資料夾 */
export async function findPythonFilesInDir(dir: string): Promise<string[]> {
    const ignored = new Set(['.git', 'node_modules', 'env', '.env', 'venv', '.venv', '.pytest_cache', '__pycache__']);
    const results: string[] = [];
    try {
        const list = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const item of list) {
            const fullPath = path.join(dir, item.name);
            if (item.isDirectory()) {
                if (ignored.has(item.name)) continue;
                results.push(...await findPythonFilesInDir(fullPath));
            } else if (item.name.endsWith('.py')) {
                results.push(fullPath);
            }
        }
    } catch { }
    return results;
}

/** 偵測突變引擎 */
export function detectMutationEngine(pythonVersion: string): 'mutatest' | 'mutmut' {
    const versionMatch = pythonVersion.match(/(\d+)\.(\d+)/);
    const major = versionMatch ? parseInt(versionMatch[1]) : 3;
    const minor = versionMatch ? parseInt(versionMatch[2]) : 0;
    return (major > 3 || (major === 3 && minor >= 12)) ? 'mutmut' : 'mutatest';
}