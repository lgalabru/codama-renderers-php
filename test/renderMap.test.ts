import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    accountNode,
    constantPdaSeedNode,
    instructionAccountNode,
    instructionArgumentNode,
    instructionNode,
    numberTypeNode,
    numberValueNode,
    pdaLinkNode,
    pdaNode,
    programNode,
    publicKeyTypeNode,
    rootNode,
    RootNode,
    stringValueNode,
    structTypeNode,
    variablePdaSeedNode,
} from '@codama/nodes';
import { visit } from '@codama/visitors-core';
import { describe, expect, it } from 'vitest';

import { getRenderMapVisitor } from '../src/getRenderMapVisitor';

function renderFixture(fixture: string, options: Parameters<typeof getRenderMapVisitor>[0] = {}) {
    const idl = JSON.parse(readFileSync(join(__dirname, '..', 'e2e', fixture, 'idl.json'), 'utf8')) as {
        program: RootNode['program'];
    };
    return visit(rootNode(idl.program), getRenderMapVisitor(options));
}

function contentOf(renders: ReturnType<typeof renderFixture>, key: string): string {
    const entry = renders.get(key) as { content: string } | string | undefined;
    expect(entry, `missing render map entry: ${key}`).toBeDefined();
    return typeof entry === 'string' ? entry : (entry as { content: string }).content;
}

describe('fixture clients', () => {
    it('renders the system client', () => {
        const renders = renderFixture('system');
        expect(contentOf(renders, 'Program.php')).toContain("public const ADDRESS = '11111111111111111111111111111111';");
        expect(contentOf(renders, 'Errors.php')).toContain('public const ACCOUNT_ALREADY_IN_USE = 0;');
        expect(contentOf(renders, 'Accounts/Nonce.php')).toContain('public const SIZE = 80;');
        expect(contentOf(renders, 'Types/NonceState.php')).toContain('enum NonceState: int');
        expect(contentOf(renders, 'Instructions/TransferSol.php')).toContain(
            'public static function instruction(Pubkey $source, Pubkey $destination, int|string $amount): Instruction',
        );
        expect(contentOf(renders, 'Shared/Borsh.php')).toContain('namespace Generated\\System\\Shared;');
        expect(contentOf(renders, 'autoload.php')).toContain("'Generated\\\\System\\\\'");
    });

    it('renders the memo client without an errors file', () => {
        const renders = renderFixture('memo');
        expect(renders.has('Errors.php')).toBe(false);
        // Remainder string: raw bytes without a prefix.
        expect(contentOf(renders, 'Instructions/AddMemo.php')).toContain('$out .= $this->memo;');
    });

    it('renders the pump-fun client', () => {
        const renders = renderFixture('pump-fun');
        const buy = contentOf(renders, 'Instructions/Buy.php');
        expect(buy).toContain('public const DISCRIMINATOR = "\\x66\\x06\\x3d\\x12\\x01\\xda\\xeb\\xea";');
        expect(buy).toContain('\\Generated\\Pump\\Types\\OptionBool $trackVolume');
        // Type alias wrapped in a single-value class.
        expect(contentOf(renders, 'Types/OptionBool.php')).toContain('final class OptionBool');
        // Nested struct types.
        expect(contentOf(renders, 'Types/Fees.php')).toContain('final class Fees');
    });

    it('renders the dummy client with optional and omitted arguments', () => {
        const renders = renderFixture('dummy');
        // Omitted field discriminator (serialized but not a constructor arg).
        const instruction3 = contentOf(renders, 'Instructions/Instruction3.php');
        expect(instruction3).toContain('public const DISCRIMINATOR = "\\x2a\\x00\\x00\\x00";');
        expect(instruction3).toContain('public function __construct() {}');
        // Optional argument with default value.
        const instruction5 = contentOf(renders, 'Instructions/Instruction5.php');
        expect(instruction5).toContain('public static function instruction(int|string|null $myArgument = null): Instruction');
        expect(instruction5).toContain('$myArgument ?? 42');
        // Optional account with the default `programId` strategy.
        const instruction7 = contentOf(renders, 'Instructions/Instruction7.php');
        expect(instruction7).toContain('?Pubkey $myAccount = null');
        expect(instruction7).toContain("new AccountMeta(Pubkey::fromBase58('Dummy11111111111111111111111111111111111111'), false, false)");
    });

    it('honors the namespace override', () => {
        const renders = renderFixture('memo', { namespace: 'Acme\\Clients\\Memo' });
        expect(contentOf(renders, 'Shared/Pubkey.php')).toContain('namespace Acme\\Clients\\Memo\\Shared;');
        expect(contentOf(renders, 'Program.php')).toContain('namespace Acme\\Clients\\Memo;');
    });
});

describe('synthetic programs', () => {
    const programId = '11111111111111111111111111111111';

    it('suffixes conflicting instruction argument names', () => {
        const program = programNode({
            instructions: [
                instructionNode({
                    accounts: [
                        instructionAccountNode({ isSigner: true, isWritable: true, name: 'amount' }),
                    ],
                    arguments: [
                        instructionArgumentNode({ name: 'amount', type: numberTypeNode('u64') }),
                    ],
                    name: 'conflicted',
                }),
            ],
            name: 'conflictProgram',
            publicKey: programId,
            version: '1.0.0',
        });
        const renders = visit(rootNode(program), getRenderMapVisitor());
        const content = contentOf(renders, 'Instructions/Conflicted.php');
        expect(content).toContain('Pubkey $amount, int|string $amountArg');
    });

    it('supports the omitted optional account strategy', () => {
        const program = programNode({
            instructions: [
                instructionNode({
                    accounts: [
                        instructionAccountNode({
                            isOptional: true,
                            isSigner: false,
                            isWritable: false,
                            name: 'maybe',
                        }),
                    ],
                    name: 'withOmitted',
                    optionalAccountStrategy: 'omitted',
                }),
            ],
            name: 'omittedProgram',
            publicKey: programId,
            version: '1.0.0',
        });
        const renders = visit(rootNode(program), getRenderMapVisitor());
        const content = contentOf(renders, 'Instructions/WithOmitted.php');
        expect(content).toContain('if ($maybe !== null) {');
    });

    it('renders secondary programs with prefixed class names', () => {
        const main = programNode({ name: 'mainProgram', publicKey: programId, version: '1.0.0' });
        const secondary = programNode({
            errors: [
                {
                    code: 0,
                    docs: [],
                    kind: 'errorNode',
                    message: 'boom',
                    name: 'boom',
                },
            ],
            name: 'secondProgram',
            publicKey: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            version: '1.0.0',
        });
        const renders = visit(rootNode(main, [secondary]), getRenderMapVisitor());
        expect(renders.has('Program.php')).toBe(true);
        expect(contentOf(renders, 'SecondProgramProgram.php')).toContain('final class SecondProgramProgram');
        expect(contentOf(renders, 'SecondProgramErrors.php')).toContain('final class SecondProgramErrors');
        // The namespace comes from the first program.
        expect(contentOf(renders, 'Program.php')).toContain('namespace Generated\\MainProgram;');
    });

    it('renders PDA helpers and rejects unsupported constant seeds', () => {
        const account = (pda: ReturnType<typeof pdaLinkNode>) =>
            accountNode({ data: structTypeNode([]), name: 'vault', pda });

        const supported = programNode({
            accounts: [account(pdaLinkNode('vault'))],
            name: 'pdaProgram',
            pdas: [
                pdaNode({
                    name: 'vault',
                    seeds: [
                        constantPdaSeedNode(numberTypeNode('u64'), numberValueNode(42)),
                        variablePdaSeedNode('index', numberTypeNode('u64')),
                    ],
                }),
            ],
            publicKey: programId,
            version: '1.0.0',
        });
        const renders = visit(rootNode(supported), getRenderMapVisitor());
        const vault = contentOf(renders, 'Accounts/Vault.php');
        expect(vault).toContain('"\\x2a\\x00\\x00\\x00\\x00\\x00\\x00\\x00",');
        // Variable seeds with a docType richer than the PHP type get a @param line.
        expect(vault).toContain('@param int|numeric-string $index');
        expect(vault).toContain('public static function findAddress(int|string $index): array');

        const unsupported = programNode({
            accounts: [account(pdaLinkNode('vault'))],
            name: 'pdaProgram',
            pdas: [
                pdaNode({
                    name: 'vault',
                    seeds: [constantPdaSeedNode(publicKeyTypeNode(), stringValueNode('nope'))],
                }),
            ],
            publicKey: programId,
            version: '1.0.0',
        });
        expect(() => visit(rootNode(unsupported), getRenderMapVisitor())).toThrow(
            'Unsupported constant PDA seed for account [Vault].',
        );
    });

    it('renders parent instructions when requested', () => {
        const parent = instructionNode({
            name: 'parentIx',
            subInstructions: [instructionNode({ name: 'childIx' })],
        });
        const program = programNode({
            instructions: [parent],
            name: 'subProgram',
            publicKey: programId,
            version: '1.0.0',
        });
        const leavesOnly = visit(rootNode(program), getRenderMapVisitor());
        expect(leavesOnly.has('Instructions/ChildIx.php')).toBe(true);
        expect(leavesOnly.has('Instructions/ParentIx.php')).toBe(false);

        const withParents = visit(rootNode(program), getRenderMapVisitor({ renderParentInstructions: true }));
        expect(withParents.has('Instructions/ChildIx.php')).toBe(true);
        expect(withParents.has('Instructions/ParentIx.php')).toBe(true);
    });
});
