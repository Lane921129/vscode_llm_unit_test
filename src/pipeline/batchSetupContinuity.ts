import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { localize } from '../i18n/core';
import { canonicalScopeRoot, BatchScopeSelection } from './batchScope';
import type { ImportSetupResult } from '../environment/importSetupController';
import type { ImportCheckTarget } from '../environment/projectImportCheck';

/** No source text leaves this snapshot. Setup cannot silently change batch scope or interpreter. */
export function captureBatchSetupScope(scope: BatchScopeSelection, python: string) {
    const root = canonicalScopeRoot(scope.root);
    const sources = scope.selectedFiles.map(file => {
        const full = path.join(scope.root, file), real = fs.realpathSync(full);
        const relative = path.relative(root, real);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) { throw new Error('Invalid batch source'); }
        return { full, real, hash: createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
    });
    return {
        verify(result: ImportSetupResult, targets: readonly ImportCheckTarget[], currentPython: string): void {
            const identity = (file: string) => {
                const real = fs.realpathSync(file);
                return process.platform === 'win32' ? real.toLowerCase() : real;
            };
            const targetIds = (values: readonly ImportCheckTarget[]) => values.map(value => identity(value.file) + '\0' + value.target).sort();
            const rows = result.rows.map(row => row.file.replace(/\\/g, '/')).sort();
            const expectedRows = [...new Set(targets.map(target => path.relative(scope.root, target.file).replace(/\\/g, '/')))].sort();
            try {
                if (result.status !== 'ready' || !result.root || canonicalScopeRoot(result.root) !== root
                    || canonicalScopeRoot(scope.root) !== root || currentPython !== python || result.python !== python
                    || JSON.stringify(targetIds(result.targets)) !== JSON.stringify(targetIds(targets))
                    || JSON.stringify(rows) !== JSON.stringify(expectedRows) || !rows.length
                    || result.rows.some(row => row.status !== 'loaded')
                    || sources.some(source => fs.realpathSync(source.full) !== source.real
                        || createHash('sha256').update(fs.readFileSync(source.full)).digest('hex') !== source.hash)) {
                    throw new Error('changed');
                }
            } catch { throw new Error(localize('初始化前後的來源、選取範圍或 Python 已改變，批次停止；請重新開始。')); }
        }
    };
}
