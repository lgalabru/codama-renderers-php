import {
    accountNode,
    amountTypeNode,
    arrayTypeNode,
    booleanTypeNode,
    bytesTypeNode,
    definedTypeNode,
    enumEmptyVariantTypeNode,
    enumTypeNode,
    fixedCountNode,
    fixedSizeTypeNode,
    mapTypeNode,
    numberTypeNode,
    optionTypeNode,
    prefixedCountNode,
    remainderCountNode,
    remainderOptionTypeNode,
    setTypeNode,
    sizePrefixTypeNode,
    stringTypeNode,
    structTypeNode,
    tupleTypeNode,
    zeroableOptionTypeNode,
} from '@codama/nodes';
import { visit, Visitor } from '@codama/visitors-core';
import { describe, expect, it } from 'vitest';

import { getTypeManifestVisitor, TypeManifest } from '../src/getTypeManifestVisitor';

function manifest(node: Parameters<typeof visit>[0], parentName: string | null = 'parent'): TypeManifest {
    const visitor = getTypeManifestVisitor({ parentName }) as Visitor<TypeManifest>;
    return visit(node, visitor) as TypeManifest;
}

describe('numbers', () => {
    it('maps every supported number format', () => {
        expect(manifest(numberTypeNode('u8')).serialize).toBe('Borsh::u8($VAR)');
        expect(manifest(numberTypeNode('u64')).phpType).toBe('int|string');
        expect(manifest(numberTypeNode('i128')).deserialize).toBe('$r->readI128()');
        expect(manifest(numberTypeNode('f64')).phpType).toBe('float');
        expect(manifest(numberTypeNode('shortU16')).serialize).toBe('Borsh::shortU16($VAR)');
    });

    it('rejects big-endian numbers', () => {
        expect(() => manifest(numberTypeNode('u32', 'be'))).toThrow('Number endianness not supported by Borsh');
    });

    it('rejects unknown number formats', () => {
        expect(() => manifest(numberTypeNode('u24' as never))).toThrow('Number format not supported: u24');
    });
});

describe('fallbacks', () => {
    it('returns the empty manifest for unsupported wrapper nodes', () => {
        const result = manifest(amountTypeNode(numberTypeNode('u64'), 9, 'SOL'));
        expect(result.phpType).toBe('mixed');
        expect(result.serialize).toBe("''");
    });

    it('returns the empty manifest for unsupported leaf nodes', () => {
        const result = manifest(enumEmptyVariantTypeNode('standalone'));
        expect(result.phpType).toBe('mixed');
        expect(result.deserialize).toBe("''");
    });

    it('visits account nodes through their data struct', () => {
        const account = accountNode({
            data: structTypeNode([]),
            name: 'counter',
        });
        const result = manifest(account, null);
        expect(result.phpType).toBe('\\%NS%\\Types\\Counter');
    });
});

describe('booleans', () => {
    it('maps u8 booleans and rejects other sizes', () => {
        expect(manifest(booleanTypeNode()).serialize).toBe('Borsh::bool($VAR)');
        expect(() => manifest(booleanTypeNode(numberTypeNode('u16')))).toThrow('Bool size not supported by Borsh');
    });
});

describe('strings and bytes', () => {
    it('maps fixed-size strings and bytes', () => {
        const fixedString = manifest(fixedSizeTypeNode(stringTypeNode('utf8'), 5));
        expect(fixedString.serialize).toBe('Borsh::fixedStr($VAR, 5)');
        expect(fixedString.deserialize).toBe('$r->readFixedString(5)');

        const fixedBytes = manifest(fixedSizeTypeNode(bytesTypeNode(), 4));
        expect(fixedBytes.serialize).toBe('Borsh::fixedBytes($VAR, 4)');
        expect(fixedBytes.deserialize).toBe('$r->read(4)');
    });

    it('maps size-prefixed strings and bytes', () => {
        const u32String = manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32')));
        expect(u32String.serialize).toBe('Borsh::str($VAR)');
        expect(u32String.deserialize).toBe('$r->readString()');

        const u16String = manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u16')));
        expect(u16String.serialize).toBe("Borsh::str($VAR, 'u16')");
        expect(u16String.deserialize).toBe("$r->readString('u16')");

        const u16Bytes = manifest(sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('u16')));
        expect(u16Bytes.serialize).toBe("Borsh::bytes($VAR, 'u16')");
        expect(u16Bytes.deserialize).toBe("$r->readBytes('u16')");

        const u32Bytes = manifest(sizePrefixTypeNode(bytesTypeNode(), numberTypeNode('u32')));
        expect(u32Bytes.serialize).toBe('Borsh::bytes($VAR)');
        expect(u32Bytes.deserialize).toBe('$r->readBytes()');
    });

    it('maps remainder strings and bytes to raw passthrough', () => {
        expect(manifest(stringTypeNode('utf8')).serialize).toBe('$VAR');
        expect(manifest(stringTypeNode('utf8')).deserialize).toBe('$r->readRemainder()');
        expect(manifest(bytesTypeNode()).serialize).toBe('$VAR');
        expect(manifest(bytesTypeNode()).deserialize).toBe('$r->readRemainder()');
    });

    it('rejects unsupported size prefixes', () => {
        expect(() => manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32', 'be')))).toThrow(
            'Size prefix endianness not supported by Borsh',
        );
        expect(() => manifest(sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u128')))).toThrow(
            'Size prefix format not supported: u128',
        );
    });
});

describe('collections', () => {
    it('maps arrays with every count strategy', () => {
        const prefixed = manifest(arrayTypeNode(numberTypeNode('u8'), prefixedCountNode(numberTypeNode('u32'))));
        expect(prefixed.serialize).toBe('Borsh::vec($VAR, fn($v1) => Borsh::u8($v1))');

        const shortPrefixed = manifest(
            arrayTypeNode(numberTypeNode('u8'), prefixedCountNode(numberTypeNode('shortU16'))),
        );
        expect(shortPrefixed.serialize).toBe("Borsh::vec($VAR, fn($v1) => Borsh::u8($v1), 'shortU16')");

        const fixed = manifest(arrayTypeNode(numberTypeNode('u8'), fixedCountNode(4)));
        expect(fixed.serialize).toBe('Borsh::vec($VAR, fn($v1) => Borsh::u8($v1), 4)');
        expect(fixed.deserialize).toBe('$r->readVec(fn() => $r->readU8(), 4)');

        const remainder = manifest(arrayTypeNode(numberTypeNode('u8'), remainderCountNode()));
        expect(remainder.serialize).toBe("Borsh::vec($VAR, fn($v1) => Borsh::u8($v1), 'remainder')");
    });

    it('maps sets and maps', () => {
        const set = manifest(setTypeNode(numberTypeNode('u16'), prefixedCountNode(numberTypeNode('u32'))));
        expect(set.serialize).toBe('Borsh::vec($VAR, fn($v1) => Borsh::u16($v1))');
        expect(set.docType).toBe('list<int>');

        const map = manifest(
            mapTypeNode(
                sizePrefixTypeNode(stringTypeNode('utf8'), numberTypeNode('u32')),
                numberTypeNode('u8'),
                prefixedCountNode(numberTypeNode('u32')),
            ),
        );
        expect(map.serialize).toBe('Borsh::map($VAR, fn($v1) => Borsh::str($v1), fn($v2) => Borsh::u8($v2))');
        expect(map.deserialize).toBe('$r->readMap(fn() => $r->readString(), fn() => $r->readU8())');
        expect(map.docType).toBe('array<string, int>');
    });

    it('maps tuples including the empty tuple', () => {
        const pair = manifest(tupleTypeNode([numberTypeNode('u8'), booleanTypeNode()]));
        expect(pair.serialize).toBe('(Borsh::u8($VAR[0]) . Borsh::bool($VAR[1]))');
        expect(pair.deserialize).toBe('[$r->readU8(), $r->readBool()]');

        const empty = manifest(tupleTypeNode([]));
        expect(empty.serialize).toBe("''");
    });

    it('maps options', () => {
        const option = manifest(optionTypeNode(numberTypeNode('u64')));
        expect(option.phpType).toBe('int|string|null');
        expect(option.serialize).toBe('Borsh::option($VAR, fn($v1) => Borsh::u64($v1))');
        expect(option.deserialize).toBe('$r->readOption(fn() => $r->readU64())');
    });
});

describe('structs and enums', () => {
    it('requires a parent name for structs and enums', () => {
        expect(() => manifest(structTypeNode([]), null)).toThrow('Struct type must have a parent name.');
        expect(() => manifest(enumTypeNode([enumEmptyVariantTypeNode('a')]), null)).toThrow(
            'Enum type must have a parent name.',
        );
    });

    it('rejects unsupported enum discriminant sizes', () => {
        const enumNode = enumTypeNode([enumEmptyVariantTypeNode('a')], { size: numberTypeNode('f32') });
        expect(() => manifest(enumNode)).toThrow('Enum discriminant size not supported by Borsh');
    });

    it('builds scalar enums with custom discriminant sizes', () => {
        const enumNode = enumTypeNode([enumEmptyVariantTypeNode('a'), enumEmptyVariantTypeNode('b')], {
            size: numberTypeNode('u32'),
        });
        const result = manifest(enumNode);
        expect(result.nestedClasses).toHaveLength(1);
        // `parent` is a PHP reserved word, so the class name gets suffixed.
        expect(result.nestedClasses[0].code).toContain('enum ParentType: int');
        expect(result.nestedClasses[0].code).toContain('Borsh::u32($this->value)');
    });
});

describe('unsupported nodes', () => {
    it('throws on remainder and zeroable options', () => {
        expect(() => manifest(remainderOptionTypeNode(numberTypeNode('u8')))).toThrow();
        expect(() => manifest(zeroableOptionTypeNode(numberTypeNode('u8')))).toThrow();
    });
});

describe('type aliases', () => {
    it('wraps non-struct defined types in a value class', () => {
        const alias = definedTypeNode({ name: 'optionBool', type: tupleTypeNode([booleanTypeNode()]) });
        const result = manifest(alias, null);
        expect(result.phpType).toBe('\\%NS%\\Types\\OptionBool');
        const wrapper = result.nestedClasses.find(nested => nested.name === 'OptionBool');
        expect(wrapper?.code).toContain('final class OptionBool');
        expect(wrapper?.code).toContain('public readonly array $value');
    });

    it('passes struct and enum defined types through', () => {
        const struct = definedTypeNode({
            name: 'myStruct',
            type: structTypeNode([]),
        });
        const result = manifest(struct, null);
        expect(result.phpType).toBe('\\%NS%\\Types\\MyStruct');
    });
});
