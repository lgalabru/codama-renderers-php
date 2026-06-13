import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    accountNode,
    arrayTypeNode,
    booleanTypeNode,
    constantPdaSeedNode,
    definedTypeLinkNode,
    definedTypeNode,
    enumEmptyVariantTypeNode,
    enumStructVariantTypeNode,
    enumTupleVariantTypeNode,
    enumTypeNode,
    fixedCountNode,
    mapTypeNode,
    numberTypeNode,
    optionTypeNode,
    pdaLinkNode,
    pdaNode,
    prefixedCountNode,
    programIdValueNode,
    programNode,
    publicKeyTypeNode,
    rootNode,
    setTypeNode,
    sizePrefixTypeNode,
    stringTypeNode,
    stringValueNode,
    structFieldTypeNode,
    structTypeNode,
    tupleTypeNode,
    variablePdaSeedNode,
} from '@codama/nodes';
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
        accounts: [
            accountNode({
                data: structTypeNode([
                    structFieldTypeNode({ name: 'wallet', type: publicKeyTypeNode() }),
                    structFieldTypeNode({ name: 'method', type: definedTypeLinkNode('paymentMethod') }),
                    structFieldTypeNode({
                        name: 'tags',
                        type: mapTypeNode(
                            sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32')),
                            numberTypeNode('u8'),
                            prefixedCountNode(numberTypeNode('u32')),
                        ),
                    }),
                    structFieldTypeNode({
                        name: 'scores',
                        type: setTypeNode(numberTypeNode('u16'), prefixedCountNode(numberTypeNode('u32'))),
                    }),
                    structFieldTypeNode({
                        name: 'fixed',
                        type: arrayTypeNode(numberTypeNode('u8'), fixedCountNode(4)),
                    }),
                    structFieldTypeNode({
                        name: 'maybePair',
                        type: optionTypeNode(tupleTypeNode([numberTypeNode('u8'), booleanTypeNode()])),
                    }),
                ]),
                name: 'wallet',
                pda: pdaLinkNode('wallet'),
            }),
        ],
        definedTypes: [
            definedTypeNode({
                name: 'paymentMethod',
                type: enumTypeNode([
                    enumEmptyVariantTypeNode('cash'),
                    enumTupleVariantTypeNode('card', tupleTypeNode([numberTypeNode('u32')])),
                    enumStructVariantTypeNode(
                        'wire',
                        structTypeNode([
                            structFieldTypeNode({ name: 'bank', type: publicKeyTypeNode() }),
                            structFieldTypeNode({
                                name: 'reference',
                                type: optionTypeNode(numberTypeNode('u64')),
                            }),
                        ]),
                    ),
                ]),
            }),
        ],
        errors: [],
        instructions: [],
        name: 'kitchenSink',
        pdas: [
            pdaNode({
                name: 'wallet',
                seeds: [
                    constantPdaSeedNode(stringTypeNode('utf8'), stringValueNode('vault')),
                    variablePdaSeedNode('owner', publicKeyTypeNode()),
                    constantPdaSeedNode(publicKeyTypeNode(), programIdValueNode()),
                ],
            }),
        ],
        publicKey: '11111111111111111111111111111111',
        version: '1.0.0',
    }),
);

describe('data enums, maps, sets and tuples', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'renderers-php-test-'));
        visit(root, renderVisitor(join(dir, 'generated'), { formatCode: false }));
    });

    afterAll(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it('generates one file per data enum variant', () => {
        const files = execSync(`find ${join(dir, 'generated')} -name '*.php'`).toString().split('\n');
        expect(files.join('\n')).toContain('Types/PaymentMethod.php');
        expect(files.join('\n')).toContain('Types/PaymentMethodCash.php');
        expect(files.join('\n')).toContain('Types/PaymentMethodCard.php');
        expect(files.join('\n')).toContain('Types/PaymentMethodWire.php');
    });

    it.runIf(hasPhp())('round-trips the generated client through PHP', () => {
        const script = `<?php
declare(strict_types=1);
require '${join(dir, 'generated', 'autoload.php')}';
use Generated\\KitchenSink\\Accounts\\Wallet;
use Generated\\KitchenSink\\Shared\\Pubkey;
use Generated\\KitchenSink\\Types\\PaymentMethodWire;

$pk = Pubkey::fromBase58('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
$wallet = new Wallet(
    wallet: $pk,
    method: new PaymentMethodWire(bank: $pk, reference: '18446744073709551615'),
    tags: ['alpha' => 1, 'beta' => 2],
    scores: [10, 20, 30],
    fixed: [1, 2, 3, 4],
    maybePair: [7, true],
);
$decoded = Wallet::fromBytes($wallet->serialize());
assert($decoded->wallet->equals($pk));
assert($decoded->method instanceof PaymentMethodWire);
assert($decoded->method->variantIndex() === 2);
assert($decoded->method->reference === '18446744073709551615');
assert($decoded->tags === ['alpha' => 1, 'beta' => 2]);
assert($decoded->scores === [10, 20, 30]);
assert($decoded->fixed === [1, 2, 3, 4]);
assert($decoded->maybePair === [7, true]);
// Empty + tuple variants.
$cash = new \\Generated\\KitchenSink\\Types\\PaymentMethodCash();
assert(\\Generated\\KitchenSink\\Types\\PaymentMethod::fromBytes($cash->serialize()) instanceof \\Generated\\KitchenSink\\Types\\PaymentMethodCash);
$card = new \\Generated\\KitchenSink\\Types\\PaymentMethodCard(12345);
$decodedCard = \\Generated\\KitchenSink\\Types\\PaymentMethod::fromBytes($card->serialize());
assert($decodedCard instanceof \\Generated\\KitchenSink\\Types\\PaymentMethodCard);
assert($decodedCard->field0 === 12345);
// None option round trip.
$none = new Wallet($pk, $cash, [], [], [0, 0, 0, 0], null);
assert(Wallet::fromBytes($none->serialize())->maybePair === null);
// PDA helper: constant seed + variable pubkey seed + programId seed.
$programId = Pubkey::fromBase58('11111111111111111111111111111111');
[$expected, $expectedBump] = \\Generated\\KitchenSink\\Shared\\Pda::findProgramAddress(
    ['vault', $pk->bytes, $programId->bytes],
    $programId,
);
[$address, $bump] = Wallet::findAddress($pk);
assert($address->equals($expected));
assert($bump === $expectedBump);
echo 'ok';
`;
        const scriptPath = join(dir, 'roundtrip.php');
        writeFileSync(scriptPath, script);
        const output = execFileSync('php', ['-d', 'zend.assertions=1', '-d', 'assert.exception=1', scriptPath], {
            encoding: 'utf8',
        });
        expect(output).toBe('ok');
    });
});
