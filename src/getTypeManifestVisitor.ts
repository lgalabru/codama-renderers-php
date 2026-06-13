import { CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, CodamaError } from '@codama/errors';
import {
    CountNode,
    InstructionArgumentNode,
    isNode,
    isScalarEnum,
    NumberTypeNode,
    parseDocs,
    pascalCase,
    REGISTERED_TYPE_NODE_KINDS,
    resolveNestedTypeNode,
    StructFieldTypeNode,
    VALUE_NODES,
} from '@codama/nodes';
import { extendVisitor, mergeVisitor, pipe, visit, Visitor } from '@codama/visitors-core';

import { renderValueNode } from './renderValueNodeVisitor';
import {
    buildDataClass,
    buildDataEnumBase,
    buildScalarEnum,
    NUMBER_FORMAT_MAP,
    nullablePhpType,
    PhpClass,
    phpClassName,
    PhpField,
    phpMemberName,
    withVar,
} from './utils';

/**
 * Describes how a Codama type node maps to PHP.
 *
 * - `phpType` / `docType`: PHP type declaration and docblock type.
 * - `serialize`: PHP expression template returning the Borsh bytes of the
 *   value designated by the `$VAR` placeholder.
 * - `deserialize`: PHP expression reading the value from a `BorshReader`
 *   instance named `$r`.
 * - `nestedClasses`: PHP classes generated for inline structs and enums.
 *
 * Generated type references use the `%NS%` placeholder for the root
 * namespace, substituted at render time.
 */
export type TypeManifest = {
    deserialize: string;
    docType: string;
    nestedClasses: PhpClass[];
    phpType: string;
    serialize: string;
};

export function getTypeManifestVisitor(options: { parentName?: string | null } = {}) {
    let parentName: string | null = options.parentName ?? null;
    let parentSize: NumberTypeNode | number | null = null;
    let varCounter = 0;

    const nextVar = (): string => `$v${++varCounter}`;

    const typeRef = (className: string, nestedClasses: PhpClass[]): TypeManifest => ({
        deserialize: `\\%NS%\\Types\\${className}::deserialize($r)`,
        docType: `\\%NS%\\Types\\${className}`,
        nestedClasses,
        phpType: `\\%NS%\\Types\\${className}`,
        serialize: '$VAR->serialize()',
    });

    const prefixFormat = (prefix: NumberTypeNode): string => {
        if (prefix.endian !== 'le') {
            throw new Error('Size prefix endianness not supported by Borsh');
        }
        if (!['shortU16', 'u16', 'u32', 'u64', 'u8'].includes(prefix.format)) {
            throw new Error(`Size prefix format not supported: ${prefix.format}`);
        }
        return prefix.format;
    };

    // Renders the trailing `$count` argument of the Borsh vec/map helpers.
    const countArg = (count: CountNode): string => {
        if (isNode(count, 'fixedCountNode')) return `, ${count.value}`;
        if (isNode(count, 'remainderCountNode')) return `, 'remainder'`;
        const format = prefixFormat(resolveNestedTypeNode(count.prefix));
        return format === 'u32' ? '' : `, '${format}'`;
    };

    return pipe(
        mergeVisitor(
            (): TypeManifest => ({
                deserialize: "''",
                docType: 'mixed',
                nestedClasses: [],
                phpType: 'mixed',
                serialize: "''",
            }),
            (_, values): TypeManifest => ({
                deserialize: "''",
                docType: 'mixed',
                nestedClasses: values.flatMap(v => v.nestedClasses),
                phpType: 'mixed',
                serialize: "''",
            }),
            { keys: [...REGISTERED_TYPE_NODE_KINDS, 'definedTypeLinkNode', 'definedTypeNode', 'accountNode'] },
        ),
        v =>
            extendVisitor(v, {
                visitAccount(account, { self }) {
                    parentName = account.name;
                    varCounter = 0;
                    const manifest = visit(account.data, self);
                    parentName = null;
                    return manifest;
                },

                visitArrayType(arrayType, { self }) {
                    const child = visit(arrayType.item, self);
                    const itemVar = nextVar();
                    return {
                        deserialize: `$r->readVec(fn() => ${child.deserialize}${countArg(arrayType.count)})`,
                        docType: `list<${child.docType}>`,
                        nestedClasses: child.nestedClasses,
                        phpType: 'array',
                        serialize: `Borsh::vec($VAR, fn(${itemVar}) => ${withVar(child.serialize, itemVar)}${countArg(arrayType.count)})`,
                    };
                },

                visitBooleanType(booleanType) {
                    const resolvedSize = resolveNestedTypeNode(booleanType.size);
                    if (resolvedSize.format === 'u8' && resolvedSize.endian === 'le') {
                        return {
                            deserialize: '$r->readBool()',
                            docType: 'bool',
                            nestedClasses: [],
                            phpType: 'bool',
                            serialize: 'Borsh::bool($VAR)',
                        };
                    }
                    throw new Error('Bool size not supported by Borsh');
                },

                visitBytesType() {
                    if (typeof parentSize === 'number') {
                        return {
                            deserialize: `$r->read(${parentSize})`,
                            docType: 'string',
                            nestedClasses: [],
                            phpType: 'string',
                            serialize: `Borsh::fixedBytes($VAR, ${parentSize})`,
                        };
                    }
                    if (parentSize && typeof parentSize === 'object') {
                        const format = prefixFormat(parentSize);
                        const arg = format === 'u32' ? '' : `, '${format}'`;
                        return {
                            deserialize: `$r->readBytes(${format === 'u32' ? '' : `'${format}'`})`,
                            docType: 'string',
                            nestedClasses: [],
                            phpType: 'string',
                            serialize: `Borsh::bytes($VAR${arg})`,
                        };
                    }
                    return {
                        deserialize: '$r->readRemainder()',
                        docType: 'string',
                        nestedClasses: [],
                        phpType: 'string',
                        serialize: '$VAR',
                    };
                },

                visitDefinedType(definedType, { self }) {
                    parentName = definedType.name;
                    varCounter = 0;
                    const manifest = visit(definedType.type, self);
                    parentName = null;

                    if (isNode(definedType.type, ['enumTypeNode', 'structTypeNode'])) {
                        return manifest;
                    }

                    // Type alias (e.g. `type OptionBool = (bool)`): wrap the
                    // underlying type in a class holding a single `$value`.
                    const className = phpClassName(definedType.name);
                    const valueField: PhpField = {
                        deserialize: manifest.deserialize,
                        docs: [],
                        docType: manifest.docType,
                        name: 'value',
                        omitted: false,
                        omittedValue: null,
                        phpType: manifest.phpType,
                        serialize: manifest.serialize,
                    };
                    const code = buildDataClass({
                        className,
                        docs: parseDocs(definedType.docs),
                        fields: [valueField],
                    });
                    return typeRef(className, [...manifest.nestedClasses, { code, name: className }]);
                },

                visitDefinedTypeLink(node) {
                    const className = phpClassName(node.name);
                    return typeRef(className, []);
                },

                visitEnumType(enumType, { self }) {
                    if (!parentName) {
                        throw new Error('Enum type must have a parent name.');
                    }
                    const className = phpClassName(parentName);
                    const sizeInfo = NUMBER_FORMAT_MAP[resolveNestedTypeNode(enumType.size).format];
                    if (!sizeInfo || sizeInfo.phpType !== 'int') {
                        throw new Error('Enum discriminant size not supported by Borsh');
                    }

                    // Scalar enum: native PHP 8.1 backed enum.
                    if (isScalarEnum(enumType)) {
                        const code = buildScalarEnum({
                            className,
                            readMethod: sizeInfo.read,
                            variants: enumType.variants.map(variant => pascalCase(variant.name)),
                            writeMethod: sizeInfo.write,
                        });
                        return typeRef(className, [{ code, name: className }]);
                    }

                    // Data enum: abstract base class + one subclass per variant.
                    const nestedClasses: PhpClass[] = [];
                    const variantInfos = enumType.variants.map((variant, index) => {
                        const variantClassName = className + pascalCase(variant.name);
                        let fields: PhpField[] = [];
                        if (isNode(variant, 'enumStructVariantTypeNode')) {
                            const struct = resolveNestedTypeNode(variant.struct);
                            fields = struct.fields.map(field => {
                                const originalParentName = parentName;
                                parentName = variantClassName + pascalCase(field.name);
                                const manifest = visit(field.type, self);
                                parentName = originalParentName;
                                nestedClasses.push(...manifest.nestedClasses);
                                return phpFieldFromManifest(field, manifest);
                            });
                        } else if (isNode(variant, 'enumTupleVariantTypeNode')) {
                            const tuple = resolveNestedTypeNode(variant.tuple);
                            fields = tuple.items.map((item, itemIndex) => {
                                const originalParentName = parentName;
                                parentName = `${variantClassName}Field${itemIndex}`;
                                const manifest = visit(item, self);
                                parentName = originalParentName;
                                nestedClasses.push(...manifest.nestedClasses);
                                return {
                                    deserialize: manifest.deserialize,
                                    docs: [],
                                    docType: manifest.docType,
                                    name: `field${itemIndex}`,
                                    omitted: false,
                                    omittedValue: null,
                                    phpType: manifest.phpType,
                                    serialize: manifest.serialize,
                                };
                            });
                        }
                        const code = buildDataClass({
                            className: variantClassName,
                            deserializeName: 'deserializeFields',
                            discriminantWrite: `Borsh::${sizeInfo.write}(self::VARIANT_INDEX)`,
                            extendsClass: className,
                            fields,
                            includeFromBytes: false,
                            variantIndex: index,
                        });
                        nestedClasses.push({ code, name: variantClassName });
                        return { className: variantClassName, index };
                    });

                    const baseCode = buildDataEnumBase({
                        className,
                        readMethod: sizeInfo.read,
                        variants: variantInfos,
                    });
                    nestedClasses.unshift({ code: baseCode, name: className });
                    return typeRef(className, nestedClasses);
                },

                visitFixedSizeType(fixedSizeType, { self }) {
                    parentSize = fixedSizeType.size;
                    const manifest = visit(fixedSizeType.type, self);
                    parentSize = null;
                    return manifest;
                },

                visitMapType(mapType, { self }) {
                    const key = visit(mapType.key, self);
                    const value = visit(mapType.value, self);
                    const keyVar = nextVar();
                    const valueVar = nextVar();
                    const count = countArg(mapType.count);
                    return {
                        deserialize: `$r->readMap(fn() => ${key.deserialize}, fn() => ${value.deserialize}${count})`,
                        docType: `array<${key.docType}, ${value.docType}>`,
                        nestedClasses: [...key.nestedClasses, ...value.nestedClasses],
                        phpType: 'array',
                        serialize: `Borsh::map($VAR, fn(${keyVar}) => ${withVar(key.serialize, keyVar)}, fn(${valueVar}) => ${withVar(value.serialize, valueVar)}${count})`,
                    };
                },

                visitNumberType(numberType) {
                    if (numberType.endian !== 'le') {
                        throw new Error('Number endianness not supported by Borsh');
                    }
                    const info = NUMBER_FORMAT_MAP[numberType.format];
                    if (!info) {
                        throw new Error(`Number format not supported: ${numberType.format}`);
                    }
                    return {
                        deserialize: `$r->${info.read}()`,
                        docType: info.docType,
                        nestedClasses: [],
                        phpType: info.phpType,
                        serialize: `Borsh::${info.write}($VAR)`,
                    };
                },

                visitOptionType(optionType, { self }) {
                    const child = visit(optionType.item, self);
                    const itemVar = nextVar();
                    return {
                        deserialize: `$r->readOption(fn() => ${child.deserialize})`,
                        docType: `${child.docType}|null`,
                        nestedClasses: child.nestedClasses,
                        phpType: nullablePhpType(child.phpType),
                        serialize: `Borsh::option($VAR, fn(${itemVar}) => ${withVar(child.serialize, itemVar)})`,
                    };
                },

                visitPublicKeyType() {
                    return {
                        deserialize: 'new Pubkey($r->read(32))',
                        docType: 'Pubkey',
                        nestedClasses: [],
                        phpType: 'Pubkey',
                        serialize: '$VAR->bytes',
                    };
                },

                visitRemainderOptionType(node) {
                    throw new CodamaError(CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, { kind: node.kind, node });
                },

                visitSetType(setType, { self }) {
                    const child = visit(setType.item, self);
                    const itemVar = nextVar();
                    const count = countArg(setType.count);
                    return {
                        deserialize: `$r->readVec(fn() => ${child.deserialize}${count})`,
                        docType: `list<${child.docType}>`,
                        nestedClasses: child.nestedClasses,
                        phpType: 'array',
                        serialize: `Borsh::vec($VAR, fn(${itemVar}) => ${withVar(child.serialize, itemVar)}${count})`,
                    };
                },

                visitSizePrefixType(sizePrefixType, { self }) {
                    parentSize = resolveNestedTypeNode(sizePrefixType.prefix);
                    const manifest = visit(sizePrefixType.type, self);
                    parentSize = null;
                    return manifest;
                },

                visitStringType() {
                    if (typeof parentSize === 'number') {
                        return {
                            deserialize: `$r->readFixedString(${parentSize})`,
                            docType: 'string',
                            nestedClasses: [],
                            phpType: 'string',
                            serialize: `Borsh::fixedStr($VAR, ${parentSize})`,
                        };
                    }
                    if (parentSize && typeof parentSize === 'object') {
                        const format = prefixFormat(parentSize);
                        const arg = format === 'u32' ? '' : `'${format}'`;
                        return {
                            deserialize: `$r->readString(${arg})`,
                            docType: 'string',
                            nestedClasses: [],
                            phpType: 'string',
                            serialize: `Borsh::str($VAR${arg ? `, ${arg}` : ''})`,
                        };
                    }
                    // Remainder string: raw bytes until the end of the data.
                    return {
                        deserialize: '$r->readRemainder()',
                        docType: 'string',
                        nestedClasses: [],
                        phpType: 'string',
                        serialize: '$VAR',
                    };
                },

                visitStructType(structType, { self }) {
                    if (!parentName) {
                        throw new Error('Struct type must have a parent name.');
                    }
                    const className = phpClassName(parentName);
                    const nestedClasses: PhpClass[] = [];
                    const fields = structType.fields.map(field => {
                        const originalParentName = parentName;
                        parentName = className + pascalCase(field.name);
                        const manifest = visit(field.type, self);
                        parentName = originalParentName;
                        nestedClasses.push(...manifest.nestedClasses);
                        return phpFieldFromManifest(field, manifest);
                    });
                    const code = buildDataClass({ className, fields });
                    nestedClasses.push({ code, name: className });
                    return typeRef(className, nestedClasses);
                },

                visitTupleType(tupleType, { self }) {
                    const items = tupleType.items.map(item => visit(item, self));
                    const serialize =
                        items.length === 0
                            ? "''"
                            : `(${items.map((item, index) => withVar(item.serialize, `$VAR[${index}]`)).join(' . ')})`;
                    return {
                        deserialize: `[${items.map(item => item.deserialize).join(', ')}]`,
                        docType: `array{ ${items.map(item => item.docType).join(', ')} }`,
                        nestedClasses: items.flatMap(item => item.nestedClasses),
                        phpType: 'array',
                        serialize,
                    };
                },

                visitZeroableOptionType(node) {
                    throw new CodamaError(CODAMA_ERROR__RENDERERS__UNSUPPORTED_NODE, { kind: node.kind, node });
                },
            }),
    );
}

/** Builds a {@link PhpField} from a struct field (or instruction argument) node and its type manifest. */
export function phpFieldFromManifest(
    field: InstructionArgumentNode | StructFieldTypeNode,
    manifest: TypeManifest,
): PhpField {
    const omitted =
        !!field.defaultValue && field.defaultValueStrategy === 'omitted' && isNode(field.defaultValue, VALUE_NODES);
    return {
        deserialize: manifest.deserialize,
        docs: parseDocs(field.docs),
        docType: manifest.docType,
        name: phpMemberName(field.name),
        omitted,
        omittedValue: omitted && field.defaultValue ? renderValueNode(field.defaultValue).render : null,
        phpType: manifest.phpType,
        serialize: manifest.serialize,
    };
}

/**
 * Visits the type of a single field with a fresh manifest visitor and
 * returns its {@link PhpField} alongside any generated nested classes.
 */
export function getPhpField(
    field: InstructionArgumentNode | StructFieldTypeNode,
    parentPrefix: string,
): PhpField & { nestedClasses: PhpClass[] } {
    const visitor = getTypeManifestVisitor({
        parentName: parentPrefix + pascalCase(field.name),
    }) as Visitor<TypeManifest>;
    const manifest = visit(field.type, visitor);
    return { ...phpFieldFromManifest(field, manifest), nestedClasses: manifest.nestedClasses };
}
