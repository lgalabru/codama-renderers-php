import { isNode, pascalCase, RegisteredValueNode, ValueNode } from '@codama/nodes';
import { visit, Visitor } from '@codama/visitors-core';

import { constantValueToBytes, getBytesFromBytesValueNode, phpBytes, phpClassName, phpMemberName, phpString } from './utils';

/**
 * Renders a Codama value node as a PHP literal expression.
 *
 * The returned code may reference generated types using the `%NS%`
 * placeholder which is substituted with the root namespace at render time.
 * The `Pubkey` runtime class is referenced by its short name and relies on
 * the `use` statements emitted by the page templates.
 */
export function renderValueNode(value: ValueNode): { render: string } {
    return { render: visit(value, renderValueNodeVisitor()) };
}

export function renderValueNodeVisitor(): Visitor<string, RegisteredValueNode['kind']> {
    return {
        visitArrayValue(node) {
            const items = node.items.map(v => visit(v, this));
            return `[${items.join(', ')}]`;
        },
        visitBooleanValue(node) {
            return node.boolean ? 'true' : 'false';
        },
        visitBytesValue(node) {
            return phpBytes(getBytesFromBytesValueNode(node));
        },
        visitConstantValue(node) {
            const bytes = constantValueToBytes(node.type, node.value);
            if (bytes === null) {
                throw new Error('Unsupported constant value type.');
            }
            return phpBytes(bytes);
        },
        visitEnumValue(node) {
            const enumName = phpClassName(node.enum.name);
            const variantName = pascalCase(node.variant);
            if (!node.value) {
                // Scalar enum variant.
                return `\\%NS%\\Types\\${enumName}::${variantName}`;
            }
            // Data enum variant: construct the variant class.
            let args: string;
            if (isNode(node.value, 'structValueNode')) {
                args = node.value.fields.map(field => visit(field, this)).join(', ');
            } else if (isNode(node.value, 'tupleValueNode')) {
                args = node.value.items.map(item => visit(item, this)).join(', ');
            } else {
                args = visit(node.value, this);
            }
            return `new \\%NS%\\Types\\${enumName}${variantName}(${args})`;
        },
        visitMapEntryValue(node) {
            return `${visit(node.key, this)} => ${visit(node.value, this)}`;
        },
        visitMapValue(node) {
            const entries = node.entries.map(entry => visit(entry, this));
            return `[${entries.join(', ')}]`;
        },
        visitNoneValue() {
            return 'null';
        },
        visitNumberValue(node) {
            return node.number.toString();
        },
        visitPublicKeyValue(node) {
            return `Pubkey::fromBase58(${phpString(node.publicKey)})`;
        },
        visitSetValue(node) {
            const items = node.items.map(v => visit(v, this));
            return `[${items.join(', ')}]`;
        },
        visitSomeValue(node) {
            return visit(node.value, this);
        },
        visitStringValue(node) {
            return phpString(node.string);
        },
        visitStructFieldValue(node) {
            return `${phpMemberName(node.name)}: ${visit(node.value, this)}`;
        },
        visitStructValue(node) {
            // Rendered as a named-argument list; only meaningful inside an
            // enclosing constructor call (e.g. a data enum variant value).
            const fields = node.fields.map(field => visit(field, this));
            return fields.join(', ');
        },
        visitTupleValue(node) {
            const items = node.items.map(v => visit(v, this));
            return `[${items.join(', ')}]`;
        },
    };
}
