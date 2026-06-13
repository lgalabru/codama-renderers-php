import { camelCase, NumberFormat, pascalCase, snakeCase } from '@codama/nodes';

/**
 * PHP reserved words that cannot be used as class names.
 * When a Codama node name collides with one of these, the
 * generated class name is suffixed with `Type`.
 */
const RESERVED_CLASS_NAMES = new Set([
    'abstract',
    'array',
    'bool',
    'callable',
    'case',
    'catch',
    'class',
    'clone',
    'const',
    'default',
    'do',
    'echo',
    'else',
    'empty',
    'enum',
    'eval',
    'exit',
    'false',
    'final',
    'float',
    'fn',
    'for',
    'foreach',
    'function',
    'global',
    'if',
    'int',
    'interface',
    'isset',
    'iterable',
    'list',
    'match',
    'mixed',
    'never',
    'new',
    'null',
    'object',
    'parent',
    'print',
    'private',
    'protected',
    'public',
    'readonly',
    'return',
    'self',
    'static',
    'string',
    'switch',
    'throw',
    'trait',
    'true',
    'try',
    'unset',
    'use',
    'var',
    'void',
    'while',
    'yield',
]);

/** Returns the PHP class name for a Codama node name. */
export function phpClassName(name: string): string {
    const pascal = pascalCase(name);
    return RESERVED_CLASS_NAMES.has(pascal.toLowerCase()) ? `${pascal}Type` : pascal;
}

/**
 * Returns the PHP property/parameter name for a Codama field name.
 * A few names are remapped because they would collide with local
 * variables used by the generated serialization code.
 */
export function phpMemberName(name: string): string {
    const camel = camelCase(name);
    if (camel === 'this') return 'thisField';
    if (camel === 'r') return 'rField';
    if (camel === 'out') return 'outField';
    if (camel === 'data') return 'dataField';
    return camel;
}

/** Returns a SCREAMING_SNAKE_CASE constant name. */
export function phpConstName(name: string): string {
    return snakeCase(name).toUpperCase();
}

/** Renders a single-quoted PHP string literal. */
export function phpString(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Renders a double-quoted PHP binary string literal (e.g. `"\x01\x02"`). */
export function phpBytes(bytes: Uint8Array | number[]): string {
    const array = Array.from(bytes);
    if (array.length === 0) return "''";
    return `"${array.map(b => `\\x${b.toString(16).padStart(2, '0')}`).join('')}"`;
}

/** Renders a PHP docblock from Codama docs. Returns an empty array when there are no docs. */
export function phpDocBlockLines(docs: string[], extraLines: string[] = []): string[] {
    const all = [...docs.filter(doc => doc.trim().length > 0), ...extraLines];
    if (all.length === 0) return [];
    if (all.length === 1) return [`/** ${all[0]} */`];
    return ['/**', ...all.map(doc => ` * ${doc}`), ' */'];
}

/** Renders a PHP docblock as a string ending with a newline, or an empty string. */
export function phpDocComment(docs: string[]): string {
    const lines = phpDocBlockLines(docs);
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Indents every non-empty line of the given code block. */
export function indentBlock(code: string, indent: string): string {
    return code
        .split('\n')
        .map(line => (line.length === 0 ? line : `${indent}${line}`))
        .join('\n');
}

const NUMBER_SIZES: Partial<Record<NumberFormat, number>> = {
    i128: 16,
    i16: 2,
    i32: 4,
    i64: 8,
    i8: 1,
    shortU16: 2,
    u128: 16,
    u16: 2,
    u32: 4,
    u64: 8,
    u8: 1,
};

/** Converts a number to its little-endian byte representation for the given format. */
export function numberToLeBytes(value: bigint | number, format: NumberFormat): Uint8Array {
    const size = NUMBER_SIZES[format];
    if (size === undefined) {
        throw new Error(`Cannot convert number format to bytes: ${format}`);
    }
    const unsigned = BigInt.asUintN(size * 8, BigInt(value));
    const bytes = new Uint8Array(size);
    let current = unsigned;
    for (let i = 0; i < size; i++) {
        bytes[i] = Number(current & 0xffn);
        current >>= 8n;
    }
    return bytes;
}

/** Substitutes the `$VAR` placeholder of a serializer template with an actual PHP expression. */
export function withVar(template: string, expression: string): string {
    return template.replace(/\$VAR/g, () => expression);
}

/** Makes a PHP type nullable. */
export function nullablePhpType(phpType: string): string {
    if (phpType.startsWith('?') || phpType.split('|').includes('null')) return phpType;
    if (phpType.includes('|')) return `${phpType}|null`;
    if (phpType === 'mixed') return 'mixed';
    return `?${phpType}`;
}

type NumberMethodInfo = { docType: string; phpType: string; read: string; write: string };

/** Maps Codama number formats to PHP types and Borsh runtime methods. */
export const NUMBER_FORMAT_MAP: Partial<Record<NumberFormat, NumberMethodInfo>> = {
    f32: { docType: 'float', phpType: 'float', read: 'readF32', write: 'f32' },
    f64: { docType: 'float', phpType: 'float', read: 'readF64', write: 'f64' },
    i128: { docType: 'int|numeric-string', phpType: 'int|string', read: 'readI128', write: 'i128' },
    i16: { docType: 'int', phpType: 'int', read: 'readI16', write: 'i16' },
    i32: { docType: 'int', phpType: 'int', read: 'readI32', write: 'i32' },
    i64: { docType: 'int', phpType: 'int', read: 'readI64', write: 'i64' },
    i8: { docType: 'int', phpType: 'int', read: 'readI8', write: 'i8' },
    shortU16: { docType: 'int', phpType: 'int', read: 'readShortU16', write: 'shortU16' },
    u128: { docType: 'int|numeric-string', phpType: 'int|string', read: 'readU128', write: 'u128' },
    u16: { docType: 'int', phpType: 'int', read: 'readU16', write: 'u16' },
    u32: { docType: 'int', phpType: 'int', read: 'readU32', write: 'u32' },
    u64: { docType: 'int|numeric-string', phpType: 'int|string', read: 'readU64', write: 'u64' },
    u8: { docType: 'int', phpType: 'int', read: 'readU8', write: 'u8' },
};
