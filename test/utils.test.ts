import {
    booleanValueNode,
    bytesTypeNode,
    bytesValueNode,
    constantDiscriminatorNode,
    constantValueNode,
    definedTypeLinkNode,
    fieldDiscriminatorNode,
    fixedSizeTypeNode,
    instructionArgumentNode,
    numberTypeNode,
    numberValueNode,
    pdaLinkNode,
    programLinkNode,
    publicKeyTypeNode,
    resolverValueNode,
    stringTypeNode,
    stringValueNode,
} from '@codama/nodes';
import { describe, expect, it } from 'vitest';

import { ImportMap } from '../src/ImportMap';
import { getBytesFromBytesValueNode } from '../src/utils/codecs';
import { constantValueToBytes, getDiscriminatorConstants } from '../src/utils/discriminatorConstant';
import { getImportFromFactory } from '../src/utils/linkOverrides';
import {
    indentBlock,
    nullablePhpType,
    numberToLeBytes,
    phpBytes,
    phpClassName,
    phpConstName,
    phpDocBlockLines,
    phpDocComment,
    phpMemberName,
    phpString,
    withVar,
} from '../src/utils/php';

describe('php utils', () => {
    it('converts node names to PHP class names', () => {
        expect(phpClassName('bonding_curve')).toBe('BondingCurve');
        // Reserved words are suffixed with `Type`.
        expect(phpClassName('global')).toBe('GlobalType');
        expect(phpClassName('list')).toBe('ListType');
    });

    it('remaps member names colliding with generated locals', () => {
        expect(phpMemberName('my_field')).toBe('myField');
        expect(phpMemberName('this')).toBe('thisField');
        expect(phpMemberName('r')).toBe('rField');
        expect(phpMemberName('out')).toBe('outField');
        expect(phpMemberName('data')).toBe('dataField');
    });

    it('renders constant names and string literals', () => {
        expect(phpConstName('accountAlreadyInUse')).toBe('ACCOUNT_ALREADY_IN_USE');
        expect(phpString("it's")).toBe("'it\\'s'");
        expect(phpString('back\\slash')).toBe("'back\\\\slash'");
    });

    it('renders binary string literals', () => {
        expect(phpBytes([])).toBe("''");
        expect(phpBytes([1, 255])).toBe('"\\x01\\xff"');
        expect(phpBytes(new Uint8Array([0]))).toBe('"\\x00"');
    });

    it('renders docblocks', () => {
        expect(phpDocBlockLines([])).toEqual([]);
        expect(phpDocBlockLines(['One line.'])).toEqual(['/** One line. */']);
        expect(phpDocBlockLines(['a', 'b'])).toEqual(['/**', ' * a', ' * b', ' */']);
        expect(phpDocComment([])).toBe('');
        expect(phpDocComment(['Hi.'])).toBe('/** Hi. */\n');
        // Blank docs are dropped.
        expect(phpDocBlockLines(['  '])).toEqual([]);
    });

    it('indents blocks while keeping blank lines empty', () => {
        expect(indentBlock('a\n\nb', '    ')).toBe('    a\n\n    b');
    });

    it('converts numbers to little-endian bytes', () => {
        expect(numberToLeBytes(0x1234, 'u16')).toEqual(new Uint8Array([0x34, 0x12]));
        expect(numberToLeBytes(-1, 'i8')).toEqual(new Uint8Array([0xff]));
        expect(numberToLeBytes(42n, 'u64')).toEqual(new Uint8Array([42, 0, 0, 0, 0, 0, 0, 0]));
        expect(() => numberToLeBytes(1.5, 'f32')).toThrow('Cannot convert number format to bytes');
    });

    it('substitutes serializer variables', () => {
        expect(withVar('Borsh::u8($VAR) . $VAR', '$value')).toBe('Borsh::u8($value) . $value');
    });

    it('makes PHP types nullable', () => {
        expect(nullablePhpType('int')).toBe('?int');
        expect(nullablePhpType('?int')).toBe('?int');
        expect(nullablePhpType('int|string')).toBe('int|string|null');
        expect(nullablePhpType('int|null')).toBe('int|null');
        expect(nullablePhpType('mixed')).toBe('mixed');
    });
});

describe('codecs', () => {
    it('decodes bytes value nodes of every encoding', () => {
        expect(getBytesFromBytesValueNode(bytesValueNode('utf8', 'ab'))).toEqual(new Uint8Array([97, 98]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base16', '01ff'))).toEqual(new Uint8Array([1, 255]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base58', '21'))).toEqual(new Uint8Array([58]));
        expect(getBytesFromBytesValueNode(bytesValueNode('base64', 'AQI='))).toEqual(new Uint8Array([1, 2]));
    });
});

describe('discriminator constants', () => {
    it('converts constant values to bytes', () => {
        expect(constantValueToBytes(numberTypeNode('u16'), numberValueNode(0x1234))).toEqual(
            new Uint8Array([0x34, 0x12]),
        );
        expect(constantValueToBytes(numberTypeNode('u16', 'be'), numberValueNode(0x1234))).toEqual(
            new Uint8Array([0x12, 0x34]),
        );
        expect(constantValueToBytes(stringTypeNode('utf8'), stringValueNode('hi'))).toEqual(
            new Uint8Array([104, 105]),
        );
        expect(
            constantValueToBytes(fixedSizeTypeNode(stringTypeNode('utf8'), 2), stringValueNode('hi')),
        ).toEqual(new Uint8Array([104, 105]));
        expect(constantValueToBytes(bytesTypeNode(), bytesValueNode('base16', 'ff'))).toEqual(
            new Uint8Array([255]),
        );
        expect(constantValueToBytes(bytesTypeNode(), booleanValueNode(true))).toEqual(new Uint8Array([1]));
        expect(constantValueToBytes(bytesTypeNode(), booleanValueNode(false))).toEqual(new Uint8Array([0]));
        // Values that cannot be statically converted yield null.
        expect(constantValueToBytes(publicKeyTypeNode(), stringValueNode('nope'))).toBeNull();
    });

    it('renders field discriminator constants', () => {
        const field = instructionArgumentNode({
            defaultValue: numberValueNode(42),
            defaultValueStrategy: 'omitted',
            name: 'discriminator',
            type: numberTypeNode('u32'),
        });
        expect(
            getDiscriminatorConstants({
                discriminatorNodes: [fieldDiscriminatorNode('discriminator')],
                fields: [field],
            }),
        ).toEqual(['public const DISCRIMINATOR = "\\x2a\\x00\\x00\\x00";']);

        // Unknown fields and fields without static defaults are skipped.
        expect(
            getDiscriminatorConstants({
                discriminatorNodes: [fieldDiscriminatorNode('missing')],
                fields: [field],
            }),
        ).toEqual([]);
        expect(
            getDiscriminatorConstants({
                discriminatorNodes: [
                    fieldDiscriminatorNode('plain'),
                ],
                fields: [instructionArgumentNode({ name: 'plain', type: numberTypeNode('u8') })],
            }),
        ).toEqual([]);
        // Default values that cannot be converted to bytes are skipped too.
        expect(
            getDiscriminatorConstants({
                discriminatorNodes: [fieldDiscriminatorNode('key')],
                fields: [
                    instructionArgumentNode({
                        defaultValue: stringValueNode('nope'),
                        defaultValueStrategy: 'omitted',
                        name: 'key',
                        type: publicKeyTypeNode(),
                    }),
                ],
            }),
        ).toEqual([]);
    });

    it('renders constant discriminator constants with index suffixes', () => {
        const first = constantDiscriminatorNode(constantValueNode(bytesTypeNode(), bytesValueNode('base16', '01')));
        const second = constantDiscriminatorNode(
            constantValueNode(bytesTypeNode(), bytesValueNode('base16', '02')),
            1,
        );
        expect(getDiscriminatorConstants({ discriminatorNodes: [first, second], fields: [] })).toEqual([
            'public const DISCRIMINATOR = "\\x01";',
            'public const DISCRIMINATOR_2 = "\\x02";',
        ]);
        // Constants that cannot be converted to bytes are skipped.
        const unsupported = constantDiscriminatorNode(
            constantValueNode(publicKeyTypeNode(), stringValueNode('nope')),
        );
        expect(getDiscriminatorConstants({ discriminatorNodes: [unsupported], fields: [] })).toEqual([]);
    });

    it('ignores unknown discriminator kinds', () => {
        const sizeDiscriminator = { kind: 'sizeDiscriminatorNode', size: 8 } as never;
        expect(getDiscriminatorConstants({ discriminatorNodes: [sizeDiscriminator], fields: [] })).toEqual([]);
    });
});

describe('link overrides', () => {
    it('resolves default and overridden import froms', () => {
        const defaults = getImportFromFactory({});
        expect(defaults(definedTypeLinkNode('foo'))).toBe('generatedTypes');
        expect(defaults(pdaLinkNode('foo'))).toBe('generatedAccounts');
        expect(defaults(programLinkNode('foo'))).toBe('generatedPrograms');
        expect(defaults(resolverValueNode('foo'))).toBe('hooked');

        const overridden = getImportFromFactory({
            definedTypes: { foo: 'custom' },
            resolvers: { foo: 'customHooked' },
        });
        expect(overridden(definedTypeLinkNode('foo'))).toBe('custom');
        expect(overridden(resolverValueNode('foo'))).toBe('customHooked');
    });

    it('resolves account and instruction links', () => {
        const factory = getImportFromFactory({ accounts: { token: 'tokenAccounts' } });
        expect(factory({ kind: 'accountLinkNode', name: 'token' } as never)).toBe('tokenAccounts');
        expect(factory({ kind: 'accountLinkNode', name: 'other' } as never)).toBe('generatedAccounts');
        expect(factory({ kind: 'instructionLinkNode', name: 'ix' } as never)).toBe('generatedInstructions');
    });

    it('throws on unexpected node kinds', () => {
        const factory = getImportFromFactory({});
        expect(() => factory({ kind: 'structTypeNode' } as never)).toThrow();
    });
});

describe('ImportMap', () => {
    it('collects, merges and renders imports', () => {
        const map = new ImportMap();
        expect(map.isEmpty()).toBe(true);
        map.add('B\\Class');
        map.add(['A\\Class']);
        map.add(new Set(['C\\Class']));

        const other = new ImportMap().add('D\\Class');
        map.mergeWith(other);

        expect(map.isEmpty()).toBe(false);
        expect([...map.imports]).toHaveLength(4);
        expect(map.toString()).toBe('use A\\Class;\nuse B\\Class;\nuse C\\Class;\nuse D\\Class;');
    });
});
