import { logError, logWarn } from '@codama/errors';
import { deleteDirectory, writeRenderMapVisitor } from '@codama/renderers-core';
import { rootNodeVisitor, visit } from '@codama/visitors-core';
import { spawnSync } from 'child_process';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { GetRenderMapOptions, getRenderMapVisitor } from './getRenderMapVisitor';

export type RenderOptions = GetRenderMapOptions & {
    deleteFolderBeforeRendering?: boolean;
    formatCode?: boolean;
};

export function renderVisitor(path: string, options: RenderOptions = {}) {
    return rootNodeVisitor(root => {
        // Delete existing generated folder.
        if (options.deleteFolderBeforeRendering ?? true) {
            deleteDirectory(path);
        }

        // Render the new files.
        visit(root, writeRenderMapVisitor(getRenderMapVisitor(options), path));

        // Lint the generated PHP code (syntax check) when PHP is available.
        if (options.formatCode ?? true) {
            lintGeneratedPhp(path);
        }
    });
}

function lintGeneratedPhp(path: string) {
    for (const file of listPhpFiles(path)) {
        const { error, status, stderr, stdout } = spawnSync('php', ['-l', file]);
        if (error?.message?.includes('ENOENT')) {
            logWarn('Could not find php, skipping syntax check.');
            return;
        }
        if (status !== 0) {
            logError(`(php -l) ${stdout?.toString() ?? ''}${stderr?.toString() ?? ''}`);
        }
    }
}

function listPhpFiles(directory: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(directory);
    } catch {
        return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
        const fullPath = join(directory, entry);
        if (statSync(fullPath).isDirectory()) {
            files.push(...listPhpFiles(fullPath));
        } else if (entry.endsWith('.php')) {
            files.push(fullPath);
        }
    }
    return files;
}
