import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { programNode, rootNode } from '@codama/nodes';
import { visit } from '@codama/visitors-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { renderVisitor } from '../src';

function hasPhp(): boolean {
    try {
        execSync('php --version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const root = rootNode(
    programNode({
        name: 'tinyProgram',
        publicKey: '11111111111111111111111111111111',
        version: '1.0.0',
    }),
);

describe('renderVisitor', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'renderers-php-visitor-'));
    });

    afterAll(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it('writes the generated client to disk', () => {
        const out = join(dir, 'generated');
        visit(root, renderVisitor(out, { formatCode: false }));
        expect(existsSync(join(out, 'autoload.php'))).toBe(true);
        expect(existsSync(join(out, 'Program.php'))).toBe(true);
        expect(readFileSync(join(out, 'Shared', 'Borsh.php'), 'utf8')).toContain(
            'namespace Generated\\TinyProgram\\Shared;',
        );
    });

    it.runIf(hasPhp())('lints the generated code and keeps existing files when asked to', () => {
        const out = join(dir, 'kept');
        mkdirSync(join(out, 'Extra'), { recursive: true });
        writeFileSync(join(out, 'Extra', 'invalid.php'), '<?php this is not valid php');
        writeFileSync(join(out, 'Extra', 'notes.txt'), 'not a php file');

        // formatCode runs `php -l` on every generated file; the pre-existing
        // invalid file is reported (logError) but does not throw.
        visit(root, renderVisitor(out, { deleteFolderBeforeRendering: false, formatCode: true }));

        expect(existsSync(join(out, 'Extra', 'invalid.php'))).toBe(true);
        expect(existsSync(join(out, 'Program.php'))).toBe(true);
    });
});
