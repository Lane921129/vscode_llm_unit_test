import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { localize } from '../i18n/core';
import { canonicalScopeRoot, BatchScopeSelection } from './batchScope';
import type { ImportSetupResult } from '../environment/importSetupController';
import type { ImportCheckTarget } from '../environment/projectImportCheck';
import { existingRealPath } from '../utils/fileIdentity';

/** No source text leaves this snapshot. Setup cannot silently change batch scope or interpreter. */
export function captureBatchSetupScope(scope: BatchScopeSelection, python: string) {
    const root = canonicalScopeRoot(scope.root);
    const sources = scope.selectedFiles.map(file => {
        const full = path.join(scope.root, file), real = existingRealPath(full);
        const relative = path.relative(root, real);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { throw new Error('Invalid batch source'); }
        return { full, real, hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
    });
    return {
        verifySources(currentPython: string): void {
            try {
                if (canonicalScopeRoot(scope.root) !== root || currentPython !== python
                    || sources.some(source => existingRealPath(source.full) !== source.real
                        || createHash('sha256').update(fs.readFileSync(source.full)).digest('hex') !== source.hash)) { throw new Error('changed'); }
            } catch { throw new Error(localize('初始化前後的來源、選取範圍或 Python 已改變，批次停止；請重新開始。')); }
        },
        verify(result: ImportSetupResult, targets: readonly ImportCheckTarget[], currentPython: string,
            options: { allowBlocked?: boolean } = {}): void {
            const identity = (file: string) => {
                const real = existingRealPath(file);
                return process.platform === 'win32' ? real.toLowerCase() : real;
            };
            const targetIds = (values: readonly ImportCheckTarget[]) => values.map(value => identity(value.file) + '\0' + value.target).sort();
            const rows = result.rows.map(row => row.file.replace(/\\/g, '/')).sort();
            try {
                const expectedRows = [...new Set(targets.map(target => path.relative(root, existingRealPath(target.file)).replace(/\\/g, '/')))].sort();
                const allowedStatus = result.status === 'ready' || options.allowBlocked && result.status === 'blocked';
                if (!allowedStatus || options.allowBlocked && result.actualImports !== true
                    || !result.root || canonicalScopeRoot(result.root) !== root
                    || canonicalScopeRoot(scope.root) !== root || currentPython !== python || result.python !== python
                    || JSON.stringify(targetIds(result.targets)) !== JSON.stringify(targetIds(targets))
                    || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !rows.length
                    || result.rows.some(row => options.allowBlocked
                        ? !['loaded', 'blocked', 'incomplete'].includes(row.status) : row.status !== 'loaded')
                    || result.initializationSources?.some(source => {
                        if (!/^[a-f0-9]{64}$/.test(source.sourceHash) || /[:\u0000-\u001f\u007f]|^[\\/]/.test(source.file)
                            || source.file.split(/[\\/]/).some(part => !part || part === '.' || part === '..')) { return true; }
                        let current = root;
                        for (const part of source.file.split(/[\\/]/)) {
                            current = path.join(current, part);
                            if (fs.lstatSync(current).isSymbolicLink()) { return true; }
                        }
                        const real = existingRealPath(current), relative = path.relative(root, real);
                        return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
                            || createHash('sha256').update(fs.readFileSync(current)).digest('hex') !== source.sourceHash;
                    })
                    || sources.some(source => existingRealPath(source.full) !== source.real
                        || createHash('sha256').update(fs.readFileSync(source.full)).digest('hex') !== source.hash)) {
                    throw new Error('changed');
                }
            } catch { throw new Error(localize('初始化前後的來源、選取範圍或 Python 已改變，批次停止；請重新開始。')); }
        }
    };
}
