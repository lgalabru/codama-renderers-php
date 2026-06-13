import {
    ConstantDiscriminatorNode,
    DiscriminatorNode,
    FieldDiscriminatorNode,
    InstructionArgumentNode,
    isNode,
    isNodeFilter,
    resolveNestedTypeNode,
    StructFieldTypeNode,
    TypeNode,
    VALUE_NODES,
    ValueNode,
} from '@codama/nodes';

import { getBytesFromBytesValueNode } from './codecs';
import { numberToLeBytes, phpBytes, phpConstName } from './php';

/**
 * Computes the raw byte representation of a constant value given its type.
 * Returns `null` when the value cannot be statically converted to bytes.
 */
export function constantValueToBytes(typeNode: TypeNode, valueNode: ValueNode): Uint8Array | null {
    const resolvedType = isNode(typeNode, ['fixedSizeTypeNode', 'sizePrefixTypeNode'])
        ? resolveNestedTypeNode(typeNode)
        : typeNode;

    if (isNode(valueNode, 'bytesValueNode')) {
        return getBytesFromBytesValueNode(valueNode);
    }
    if (isNode(resolvedType, 'numberTypeNode') && isNode(valueNode, 'numberValueNode')) {
        const bytes = numberToLeBytes(valueNode.number, resolvedType.format);
        return resolvedType.endian === 'be' ? bytes.reverse() : bytes;
    }
    if (isNode(resolvedType, 'stringTypeNode') && isNode(valueNode, 'stringValueNode')) {
        return new TextEncoder().encode(valueNode.string);
    }
    if (isNode(valueNode, 'booleanValueNode')) {
        return new Uint8Array([valueNode.boolean ? 1 : 0]);
    }
    return null;
}

/**
 * Renders PHP class constants for the discriminators of an account or instruction.
 * Each constant holds the raw discriminator bytes as a PHP binary string.
 */
export function getDiscriminatorConstants(scope: {
    discriminatorNodes: DiscriminatorNode[];
    fields: InstructionArgumentNode[] | StructFieldTypeNode[];
}): string[] {
    const { discriminatorNodes, fields } = scope;
    return discriminatorNodes.flatMap(node => {
        switch (node.kind) {
            case 'constantDiscriminatorNode':
                return getConstantDiscriminatorConstant(node, discriminatorNodes);
            case 'fieldDiscriminatorNode':
                return getFieldDiscriminatorConstant(node, fields);
            default:
                return [];
        }
    });
}

function getConstantDiscriminatorConstant(
    node: ConstantDiscriminatorNode,
    discriminatorNodes: DiscriminatorNode[],
): string[] {
    const index = discriminatorNodes.filter(isNodeFilter('constantDiscriminatorNode')).indexOf(node);
    const suffix = index <= 0 ? '' : `_${index + 1}`;
    const bytes = constantValueToBytes(node.constant.type, node.constant.value);
    if (bytes === null) return [];
    return [`public const DISCRIMINATOR${suffix} = ${phpBytes(bytes)};`];
}

function getFieldDiscriminatorConstant(
    node: FieldDiscriminatorNode,
    fields: InstructionArgumentNode[] | StructFieldTypeNode[],
): string[] {
    const field = fields.find(f => f.name === node.name);
    if (!field || !field.defaultValue || !isNode(field.defaultValue, VALUE_NODES)) {
        return [];
    }
    const bytes = constantValueToBytes(field.type, field.defaultValue);
    if (bytes === null) return [];
    return [`public const ${phpConstName(node.name)} = ${phpBytes(bytes)};`];
}
