import {
    arrayValueNode,
    booleanValueNode,
    bytesTypeNode,
    bytesValueNode,
    constantValueNode,
    enumValueNode,
    mapEntryValueNode,
    mapValueNode,
    noneValueNode,
    numberValueNode,
    publicKeyTypeNode,
    publicKeyValueNode,
    setValueNode,
    someValueNode,
    stringValueNode,
    structFieldValueNode,
    structValueNode,
    tupleValueNode,
} from '@codama/nodes';
import { describe, expect, it } from 'vitest';

import { renderValueNode } from '../src/renderValueNodeVisitor';

describe('renderValueNode', () => {
    it('renders scalar values', () => {
        expect(renderValueNode(numberValueNode(42)).render).toBe('42');
        expect(renderValueNode(booleanValueNode(true)).render).toBe('true');
        expect(renderValueNode(booleanValueNode(false)).render).toBe('false');
        expect(renderValueNode(stringValueNode('hello')).render).toBe("'hello'");
        expect(renderValueNode(noneValueNode()).render).toBe('null');
        expect(renderValueNode(someValueNode(numberValueNode(7))).render).toBe('7');
    });

    it('renders bytes and constants', () => {
        expect(renderValueNode(bytesValueNode('base16', '01ff')).render).toBe('"\\x01\\xff"');
        expect(renderValueNode(constantValueNode(bytesTypeNode(), bytesValueNode('utf8', 'ab'))).render).toBe(
            '"\\x61\\x62"',
        );
        expect(() =>
            renderValueNode(constantValueNode(publicKeyTypeNode(), stringValueNode('nope'))),
        ).toThrow('Unsupported constant value type.');
    });

    it('renders public keys', () => {
        expect(renderValueNode(publicKeyValueNode('11111111111111111111111111111111')).render).toBe(
            "Pubkey::fromBase58('11111111111111111111111111111111')",
        );
    });

    it('renders collections', () => {
        expect(renderValueNode(arrayValueNode([numberValueNode(1), numberValueNode(2)])).render).toBe('[1, 2]');
        expect(renderValueNode(setValueNode([stringValueNode('a')])).render).toBe("['a']");
        expect(renderValueNode(tupleValueNode([numberValueNode(1), booleanValueNode(true)])).render).toBe(
            '[1, true]',
        );
        expect(
            renderValueNode(
                mapValueNode([
                    mapEntryValueNode(stringValueNode('k'), numberValueNode(9)),
                ]),
            ).render,
        ).toBe("['k' => 9]");
    });

    it('renders struct fields and struct values', () => {
        expect(renderValueNode(structFieldValueNode('my_field', numberValueNode(3))).render).toBe('myField: 3');
        expect(
            renderValueNode(
                structValueNode([
                    structFieldValueNode('a', numberValueNode(1)),
                    structFieldValueNode('b', numberValueNode(2)),
                ]),
            ).render,
        ).toBe('a: 1, b: 2');
    });

    it('renders enum variants', () => {
        // Scalar variant.
        expect(renderValueNode(enumValueNode('nonce_state', 'initialized')).render).toBe(
            '\\%NS%\\Types\\NonceState::Initialized',
        );
        // Struct variant.
        expect(
            renderValueNode(
                enumValueNode(
                    'payment_method',
                    'wire',
                    structValueNode([structFieldValueNode('bank', numberValueNode(1))]),
                ),
            ).render,
        ).toBe('new \\%NS%\\Types\\PaymentMethodWire(bank: 1)');
        // Tuple variant: items become constructor arguments.
        expect(
            renderValueNode(enumValueNode('payment_method', 'card', tupleValueNode([numberValueNode(4)]))).render,
        ).toBe('new \\%NS%\\Types\\PaymentMethodCard(4)');
        // Single-value variant.
        expect(renderValueNode(enumValueNode('payment_method', 'card', numberValueNode(4))).render).toBe(
            'new \\%NS%\\Types\\PaymentMethodCard(4)',
        );
    });
});
