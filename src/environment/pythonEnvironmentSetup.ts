import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { killProcessTree } from '../utils/processRunner';
import { pythonToolPath } from '../pipeline/pythonTools';
import { inferTargetImportModule } from '../utils/dependencyResolver';
import { DependencyInventory, inventorySummary, isDependencyInventory } from './dependencyInventory';
import { createPythonInstallationPlan, installationPlanFilesUnchanged, PythonInstallationPlan } from './pythonInstallationPlan';

export class EnvironmentSetupError extends Error {
    constructor(readonly stage: string, message: string) { super(message); }
}
export interface SetupCommand {
    executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
    input?: string; timeoutMs?: number; signal?: AbortSignal; stdoutLimit?: number;
}
export type SetupRunner = (command: SetupCommand) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Capture bounded output; installer responses may contain private URLs and never reach the UI. */
export const runSetupCommand: SetupRunner = command => new Promise((resolve, reject) => {
    if (command.signal?.aborted) { reject(new Error('cancelled')); return; }
    const proc = spawn(command.executable, command.args, {
        cwd: command.cwd, env: command.env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '', stopped = false;
    const stop = () => { stopped = true; killProcessTree(proc); };
    const timer = setTimeout(stop, command.timeoutMs || 15 * 60 * 1000);
    command.signal?.addEventListener('abort', stop, { once: true });
    if (command.signal?.aborted) { stop(); }
    const cleanup = () => { clearTimeout(timer); command.signal?.removeEventListener('abort', stop); };
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-(command.stdoutLimit || 65536)); });
    proc.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
    proc.stdin.on('error', () => { /* A failed interpreter can close stdin before reading. */ });
    proc.on('error', () => { cleanup(); reject(new Error('process-start-failed')); });
    // Do not release the installation lock until the child has actually exited.
    proc.on('close', code => { cleanup(); resolve({ code: stopped ? null : code, stdout, stderr }); });
    proc.stdin.end(command.input);
});

export function setupEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const key of Object.keys(env)) {
        if (/^(?:PYTHONPATH|PYTHONHOME|PIP_TARGET|PIP_PREFIX|PIP_USER|PIP_ROOT|PIP_PYTHON|PIP_LOG|PIP_BREAK_SYSTEM_PACKAGES|PIP_UPGRADE|PIP_FORCE_REINSTALL|PIP_IGNORE_INSTALLED)$/i.test(key)) {
            delete env[key];
        }
    }
    return { ...env, PYTHONIOENCODING: 'utf-8', PIP_CONFIG_FILE: os.devNull,
        PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1' };
}

export interface PythonCandidate { executable: string; args?: string[] }
export interface EnvironmentInspection {
    python: string; version: number[]; virtual: boolean; coverage: boolean;
    status: 'ready' | 'interpreter-only' | 'missing' | 'local-or-submodule' | 'stdlib' | 'blocked' | 'import-error';
    missing?: string; operation?: string; inventory?: DependencyInventory;
}

/** Search only the selected target's ancestor chain, not unrelated projects or dependency folders. */
export function findRequirementFiles(projectRoot: string, file: string, scope: 'file' | 'folder' = 'file'): string[] {
    const root = path.resolve(projectRoot);
    let directory = scope === 'folder' ? path.resolve(file) : path.dirname(path.resolve(file));
    if (path.relative(root, directory).startsWith('..')) { directory = root; }
    for (;;) {
        const files = fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^requirements(?:[-_.][\w-]+)?\.txt$/i.test(entry.name))
            .map(entry => path.join(directory, entry.name));
        if (files.length) { return files.sort((a, b) => Number(path.basename(b) === 'requirements.txt') - Number(path.basename(a) === 'requirements.txt') || a.localeCompare(b)); }
        if (directory === root || path.dirname(directory) === directory) { return []; }
        directory = path.dirname(directory);
    }
}

export async function inspectPython(candidate: PythonCandidate, projectRoot: string, file: string,
    runner: SetupRunner = runSetupCommand, signal?: AbortSignal, scope: 'file' | 'folder' = 'file',
    excludedPaths: string[] = []): Promise<EnvironmentInspection | undefined> {
    const directory = path.dirname(file);
    const result = await runner({
        executable: candidate.executable, args: [...candidate.args || [], '-B', pythonToolPath('environment')],
        cwd: os.tmpdir(), env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeoutMs: scope === 'folder' ? 60000 : 15000,
        signal, stdoutLimit: scope === 'folder' ? 2 * 1024 * 1024 : undefined,
        input: JSON.stringify(scope === 'folder' ? { scanRoot: file, sourceRoot: projectRoot, excludedPaths }
            : { file, module: inferTargetImportModule(file), sourceRoot: projectRoot,
            importPaths: [directory, path.dirname(directory), path.dirname(path.dirname(directory)), projectRoot] })
    });
    if (result.code !== 0) { return undefined; }
    try {
        const value = JSON.parse(result.stdout) as EnvironmentInspection;
        return typeof value.python === 'string' && path.isAbsolute(value.python) && value.version?.[0] === 3
            && ['ready', 'missing', 'local-or-submodule', 'stdlib', 'blocked', 'import-error'].includes(value.status)
            && (scope !== 'folder' || (isDependencyInventory(value.inventory)
                && value.status === (!value.inventory.complete ? 'import-error' : value.inventory.missing.length ? 'missing' : 'ready')
                && (value.status !== 'missing' || value.missing === value.inventory.missing[0])))
            && typeof value.coverage === 'boolean' ? value : undefined;
    } catch { return undefined; }
}

function installationFailure(stage: string, output: { code: number | null; stdout: string; stderr: string }): void {
    if (output.code === 0) { return; }
    const diagnostic = output.stdout + output.stderr;
    const reason = output.code === null ? '執行逾時或被中止。'
        : /externally-managed-environment|EXTERNALLY-MANAGED/i.test(diagnostic) ? '此 Python 由系統套件管理器管理，不能直接使用 pip 修改；請選取原應用的 Python 環境。'
        : /PermissionError|Permission denied|Access is denied/i.test(diagnostic) ? '目前 Python 的套件目錄無寫入權限，請選取可寫入的原應用環境。'
        : /ResolutionImpossible|conflicting dependencies|dependency conflict/i.test(diagnostic) ? '相依版本衝突，請確認原應用相依清單。'
        : /No matching distribution|Requires-Python|requires a different Python/i.test(diagnostic) ? '找不到符合目前 Python／平台的套件；import 名稱可能與安裝名稱不同。'
        : /ConnectionError|ConnectTimeout|ProxyError|SSLError|CERTIFICATE_VERIFY_FAILED|Temporary failure|Connection refused/i.test(diagnostic) ? '無法連線至套件來源，請檢查網路、代理伺服器或憑證設定。'
        : stage === 'check' ? '已安裝套件的相依不完整或版本不相容。'
        : '套件安裝未完成，請檢查相依清單、套件名稱與建置需求。';
    throw new EnvironmentSetupError(stage, reason + ' 尚未標示環境就緒。');
}

function requireImportable(value: EnvironmentInspection): void {
    if (value.inventory && !value.inventory.complete) {
        throw new EnvironmentSetupError('dependency-scan', '相依掃描不完整，請先處理報告中的語法、讀取或容量問題；未標示環境就緒。');
    }
    if (value.status === 'ready' || value.status === 'missing') { return; }
    const message = value.status === 'blocked' ? '模組載入副作用被隔離規則攔下；需要調整原應用初始化，安裝套件無法解決。'
        : value.status === 'local-or-submodule' ? '找不到專案模組或已安裝套件的子模組；請檢查來源路徑、套件版本與 import，不會把它當成新的外部套件安裝。'
        : value.status === 'stdlib' ? 'Python 標準庫不完整或版本不相容，請檢查原應用需要的 Python 版本。'
        : '模組匯入失敗，但不是可確認的缺套件錯誤；請查看正式預檢報告。';
    throw new EnvironmentSetupError('module-import', message);
}

/** Reuse a working interpreter first. Only an explicitly invoked preparation installs missing dependencies. */
export async function preparePythonEnvironment(options: {
    projectRoot: string; file: string; candidates: PythonCandidate[]; toolRequirements: string;
    scope?: 'file' | 'folder'; excludedPaths?: string[]; inventory?: (scan: DependencyInventory) => void;
    signal?: AbortSignal; progress?: (message: string) => void;
    chooseRequirements?: (files: string[]) => Promise<string | undefined>;
    packageName?: (missing: string) => Promise<string | undefined>;
    confirmInstall?: (plan: PythonInstallationPlan) => Promise<boolean>;
}, runner: SetupRunner = runSetupCommand): Promise<{ python: string; requirements?: string; installed: string[]; inventory?: DependencyInventory }> {
    const cancelled = () => {
        if (options.signal?.aborted) { throw new EnvironmentSetupError('cancelled', '環境準備已取消；已安裝的套件會保留，下次會重新檢查。'); }
    };
    const progress = (message: string) => { cancelled(); options.progress?.(message); };
    const scope = options.scope || 'file';
    if (!fs.existsSync(options.file) || !(scope === 'folder' ? fs.statSync(options.file).isDirectory() : fs.statSync(options.file).isFile())) {
        throw new EnvironmentSetupError('target', '請先選擇有效的 Python 檔案或來源資料夾。');
    }
    const inspect = (candidate: PythonCandidate) => inspectPython(candidate, options.projectRoot, options.file,
        runner, options.signal, scope, options.excludedPaths);
    const report = (value: EnvironmentInspection) => {
        if (value.inventory) { options.inventory?.(value.inventory); progress(inventorySummary(value.inventory)); }
    };
    let selected: EnvironmentInspection | undefined;
    const seen = new Set<string>();
    for (const candidate of options.candidates.slice(0, 32)) {
        cancelled();
        progress('正在檢查現有 Python 與目標模組相依…');
        let value: EnvironmentInspection | undefined;
        try { value = await inspect(candidate); }
        catch { cancelled(); continue; }
        cancelled();
        if (!value || seen.has(value.python)) { continue; }
        seen.add(value.python);
        if (value.status === 'ready' && value.coverage) { selected = value; break; }
        if (!selected || (value.status === 'ready' && selected.status !== 'ready')
            || (value.status === 'missing' && selected.status !== 'missing' && selected.status !== 'ready')) { selected = value; }
    }
    if (!selected) { throw new EnvironmentSetupError('python', '找不到可執行的 Python 3。請先安裝 Python，或設定 llmUnitTest.pythonPath。'); }
    report(selected);
    requireImportable(selected);
    const python = selected.python;
    progress('選用 Python：' + python);
    const installed: string[] = [];
    const approvedOperations = new Map<string, PythonInstallationPlan>();
    const approvedMappings = new Map<string, string>();
    const operationKey = (args: string[], cwd: string) => JSON.stringify([args, cwd]);
    const install = async (args: string[], cwd: string) => {
        cancelled();
        const approved = approvedOperations.get(operationKey(args, cwd));
        if (!approved || !installationPlanFilesUnchanged(approved)) {
            throw new EnvironmentSetupError('install-plan', '安裝清單尚未確認或 requirements 已變更，請重新檢查並確認後再安裝。');
        }
        approvedOperations.delete(operationKey(args, cwd));
        const output = await runner({ executable: python,
            args: ['-B', pythonToolPath('installer'), 'install', '--no-input', '--disable-pip-version-check', ...args],
            cwd, env: setupEnvironment(process.env), signal: options.signal });
        cancelled();
        installationFailure('install', output);
    };
    let requirements: string | undefined;
    const approve = async (current: EnvironmentInspection) => {
        const plan = await createPythonInstallationPlan({ python, virtual: current.virtual, target: options.file,
            projectRoot: options.projectRoot, inventory: current.inventory,
            missing: current.status === 'missing' ? current.inventory?.missing || [current.missing || ''] : [],
            requirements, toolRequirements: options.toolRequirements, needsTools: !current.coverage,
            packageName: options.packageName, previouslyInstalled: installed });
        cancelled();
        // The callback receives a copy; UI code cannot expand the approved operations.
        const accepted = await options.confirmInstall?.(structuredClone(plan));
        cancelled();
        if (plan.blockers.length) { throw new EnvironmentSetupError('dependency', plan.blockers.join(' ')); }
        if (accepted !== true) {
            throw new EnvironmentSetupError('install-plan', installed.length
                ? '已取消此安裝清單；先前已完成的安裝會保留，環境尚未就緒。'
                : '未確認安裝清單，本次未安裝任何套件，也未變更 Python 設定。');
        }
        if (!installationPlanFilesUnchanged(plan)) {
            throw new EnvironmentSetupError('install-plan', 'requirements 在確認期間已變更，請重新檢查並確認新的安裝清單。');
        }
        for (const operation of plan.operations) { approvedOperations.set(operationKey(operation.args, operation.cwd), plan); }
        for (const [module, name] of Object.entries(plan.mappings)) { approvedMappings.set(module, name); }
    };
    if (selected.status === 'missing' || !selected.coverage) {
        const files = findRequirementFiles(options.projectRoot, options.file, scope);
        requirements = files.length === 1 ? files[0] : files.length ? await options.chooseRequirements?.(files) : undefined;
        cancelled();
        if (files.length && !requirements) { throw new EnvironmentSetupError('requirements', '尚未選擇相依清單，未安裝任何套件。'); }
        if (requirements && !files.includes(requirements)) { throw new EnvironmentSetupError('requirements', '相依清單不屬於目前選取的專案。'); }
        progress('檢查完成，等待確認安裝清單…');
        await approve(selected);
        if (requirements && selected.status === 'missing') {
            progress('依原專案 requirements 安裝相依…');
            await install(['-r', requirements], path.dirname(requirements));
            installed.push('requirements');
        }
    }
    const missingAttempts = new Set<string>();
    for (let attempt = 0; attempt <= 20; attempt++) {
        cancelled();
        const current = await inspect({ executable: python });
        cancelled();
        if (!current) { throw new EnvironmentSetupError('probe', '無法完成安裝後的環境檢查。'); }
        report(current);
        requireImportable(current);
        if (current.status === 'ready') { selected = current; break; }
        const missing = current.missing;
        if (!missing || !/^[A-Za-z][A-Za-z0-9_]*$/.test(missing)) {
            throw new EnvironmentSetupError('dependency', '缺少的模組名稱無法可靠對應外部套件，請檢查原應用的相依宣告。');
        }
        // A present requirements file is authoritative; never silently override its pins.
        if (requirements) { throw new EnvironmentSetupError('dependency', '依 requirements 安裝後仍缺少 ' + missing + '，請補齊原應用相依清單。'); }
        if (missingAttempts.has(missing) || attempt === 20) {
            throw new EnvironmentSetupError('dependency', '安裝後仍缺少 ' + missing + ' 或已達補裝上限；請確認套件名稱／版本，停止重複安裝。');
        }
        missingAttempts.add(missing);
        if (!approvedMappings.has(missing)) { await approve(current); }
        const name = approvedMappings.get(missing);
        cancelled();
        if (!name) {
            throw new EnvironmentSetupError('dependency', '缺少 ' + missing
                + '，但無法僅憑 import 名稱確認外部套件；請補充 requirements 或 llmUnitTest.packageMappings 的明確對應，未安裝猜測套件。');
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
            throw new EnvironmentSetupError('dependency', '安裝名稱必須是單一套件名稱，不接受網址、路徑或 pip 引數。');
        }
        progress('缺少 ' + missing + '，正在安裝 ' + name + '…');
        await install([name], options.projectRoot);
        installed.push(name);
    }
    if (!selected.coverage) {
        if (!fs.existsSync(options.toolRequirements)) { throw new EnvironmentSetupError('tools', '擴充套件的測試工具相依清單遺失，請重新安裝擴充套件。'); }
        progress('正在補齊 coverage 與突變測試工具…');
        const args = ['-r', options.toolRequirements, ...requirements ? ['-r', requirements] : []];
        if (!approvedOperations.has(operationKey(args, options.projectRoot))) { await approve(selected); }
        await install(args, options.projectRoot);
        installed.push('test-tools');
    }
    progress('正在確認相依版本與最終匯入結果…');
    if (installed.length) {
        const check = await runner({ executable: python, args: ['-m', 'pip', 'check'],
            cwd: os.tmpdir(), env: setupEnvironment(process.env), timeoutMs: 30000, signal: options.signal });
        cancelled();
        installationFailure('check', check);
    }
    const final = await inspect({ executable: python });
    cancelled();
    if (final) { report(final); }
    if (!final || final.status !== 'ready' || !final.coverage) {
        throw new EnvironmentSetupError('verify', '最終模組或 coverage 檢查未通過，環境尚未就緒。');
    }
    return { python, requirements, installed, inventory: final.inventory };
}

/** Prevent installations from changing an environment used by analysis or qualification. */
export class PythonEnvironmentActivity {
    private users = 0;
    private installing = false;
    acquire(mode: 'use' | 'setup'): (() => void) | undefined {
        if (this.installing || (mode === 'setup' && this.users > 0)) { return undefined; }
        if (mode === 'setup') { this.installing = true; } else { this.users++; }
        let released = false;
        return () => {
            if (released) { return; }
            released = true;
            if (mode === 'setup') { this.installing = false; } else { this.users--; }
        };
    }
}
export const pythonEnvironmentActivity = new PythonEnvironmentActivity();
