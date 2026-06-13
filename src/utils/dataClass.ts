import { indentBlock, phpDocBlockLines, withVar } from './php';

/** A fully rendered PHP class (or enum) and its name. */
export type PhpClass = { code: string; name: string };

/** Everything needed to render one field of a generated data class. */
export type PhpField = {
    /** PHP expression reading the field from a `BorshReader` named `$r`. */
    deserialize: string;
    docs: string[];
    /** Richer type used in docblocks (e.g. `list<int>`). */
    docType: string;
    /** PHP property/parameter name (camelCase). */
    name: string;
    /** True when the field has `defaultValueStrategy === 'omitted'`. */
    omitted: boolean;
    /** PHP literal used to serialize an omitted field. */
    omittedValue: string | null;
    /** PHP type declaration used for the promoted property. */
    phpType: string;
    /** PHP expression template (with `$VAR` placeholder) returning the serialized bytes. */
    serialize: string;
};

export type DataClassOptions = {
    abstract?: boolean;
    className: string;
    /** Raw constant declarations, e.g. `public const DISCRIMINATOR = "\x01";`. */
    constants?: string[];
    /** Name of the static deserializer (defaults to `deserialize`). */
    deserializeName?: string;
    /** Serialized bytes prepended in `serialize()` (e.g. enum variant index). */
    discriminantWrite?: string;
    docs?: string[];
    extendsClass?: string;
    /** Raw method code blocks appended to the class (unindented). */
    extraMethods?: string[];
    fields: PhpField[];
    includeFromBytes?: boolean;
    /** When set, adds a `VARIANT_INDEX` constant and a `variantIndex()` method. */
    variantIndex?: number;
};

/** Renders a PHP data class with promoted readonly properties and Borsh serialization. */
export function buildDataClass(options: DataClassOptions): string {
    const {
        className,
        constants = [],
        deserializeName = 'deserialize',
        discriminantWrite,
        docs = [],
        extendsClass,
        extraMethods = [],
        fields,
        includeFromBytes = true,
        variantIndex,
    } = options;
    const ctorFields = fields.filter(field => !field.omitted);

    const lines: string[] = [];
    lines.push(...phpDocBlockLines(docs));
    const extendsClause = extendsClass ? ` extends ${extendsClass}` : '';
    lines.push(`final class ${className}${extendsClause}`);
    lines.push('{');

    const body: string[] = [];

    // Constants.
    const allConstants = [...constants];
    if (variantIndex !== undefined) {
        allConstants.unshift(`public const VARIANT_INDEX = ${variantIndex};`);
    }
    if (allConstants.length > 0) {
        body.push(allConstants.map(constant => `    ${constant}`).join('\n\n'));
    }

    // Constructor.
    const ctorDocs = ctorFields.flatMap(field => {
        const fieldDocs = field.docs.filter(doc => doc.trim().length > 0).join(' ');
        if (field.docType === field.phpType && fieldDocs.length === 0) return [];
        return [`@param ${field.docType} $${field.name}${fieldDocs ? ` ${fieldDocs}` : ''}`];
    });
    const ctor: string[] = [];
    ctor.push(...phpDocBlockLines([], ctorDocs).map(line => `    ${line}`));
    if (ctorFields.length === 0) {
        ctor.push('    public function __construct() {}');
    } else {
        ctor.push('    public function __construct(');
        for (const field of ctorFields) {
            ctor.push(`        public readonly ${field.phpType} $${field.name},`);
        }
        ctor.push('    ) {}');
    }
    body.push(ctor.join('\n'));

    // variantIndex().
    if (variantIndex !== undefined) {
        body.push(
            [
                '    public function variantIndex(): int',
                '    {',
                '        return self::VARIANT_INDEX;',
                '    }',
            ].join('\n'),
        );
    }

    // serialize().
    const serialize: string[] = [];
    serialize.push('    public function serialize(): string');
    serialize.push('    {');
    serialize.push(`        $out = ${discriminantWrite ?? "''"};`);
    for (const field of fields) {
        const expression = field.omitted
            ? withVar(field.serialize, field.omittedValue ?? 'null')
            : withVar(field.serialize, `$this->${field.name}`);
        serialize.push(`        $out .= ${expression};`);
    }
    serialize.push('        return $out;');
    serialize.push('    }');
    body.push(serialize.join('\n'));

    // fromBytes().
    if (includeFromBytes) {
        body.push(
            [
                '    public static function fromBytes(string $data): self',
                '    {',
                '        return self::deserialize(new BorshReader($data));',
                '    }',
            ].join('\n'),
        );
    }

    // deserialize().
    const deserialize: string[] = [];
    deserialize.push(`    public static function ${deserializeName}(BorshReader $r): self`);
    deserialize.push('    {');
    for (const field of fields) {
        if (field.omitted) {
            deserialize.push(`        ${field.deserialize};`);
        } else {
            deserialize.push(`        $${field.name} = ${field.deserialize};`);
        }
    }
    deserialize.push(`        return new self(${ctorFields.map(field => `$${field.name}`).join(', ')});`);
    deserialize.push('    }');
    body.push(deserialize.join('\n'));

    // Extra methods.
    for (const method of extraMethods) {
        body.push(indentBlock(method, '    '));
    }

    lines.push(body.join('\n\n'));
    lines.push('}');
    return lines.join('\n');
}

export type ScalarEnumOptions = {
    className: string;
    docs?: string[];
    /** Borsh write method for the discriminant (e.g. `u8`, `u32`). */
    readMethod: string;
    variants: string[];
    writeMethod: string;
};

/** Renders a PHP 8.1 backed enum for a Codama scalar enum. */
export function buildScalarEnum(options: ScalarEnumOptions): string {
    const { className, docs = [], readMethod, variants, writeMethod } = options;
    const lines: string[] = [];
    lines.push(...phpDocBlockLines(docs));
    lines.push(`enum ${className}: int`);
    lines.push('{');
    variants.forEach((variant, index) => {
        lines.push(`    case ${variant} = ${index};`);
    });
    lines.push('');
    lines.push('    public function serialize(): string');
    lines.push('    {');
    lines.push(`        return Borsh::${writeMethod}($this->value);`);
    lines.push('    }');
    lines.push('');
    lines.push('    public static function fromBytes(string $data): self');
    lines.push('    {');
    lines.push('        return self::deserialize(new BorshReader($data));');
    lines.push('    }');
    lines.push('');
    lines.push('    public static function deserialize(BorshReader $r): self');
    lines.push('    {');
    lines.push(`        return self::from($r->${readMethod}());`);
    lines.push('    }');
    lines.push('}');
    return lines.join('\n');
}

export type DataEnumBaseOptions = {
    className: string;
    docs?: string[];
    readMethod: string;
    variants: { className: string; index: number }[];
};

/** Renders the abstract base class of a Codama data enum (tagged union). */
export function buildDataEnumBase(options: DataEnumBaseOptions): string {
    const { className, docs = [], readMethod, variants } = options;
    const lines: string[] = [];
    lines.push(...phpDocBlockLines(docs));
    lines.push(`abstract class ${className}`);
    lines.push('{');
    lines.push('    abstract public function variantIndex(): int;');
    lines.push('');
    lines.push('    abstract public function serialize(): string;');
    lines.push('');
    lines.push('    public static function fromBytes(string $data): self');
    lines.push('    {');
    lines.push('        return self::deserialize(new BorshReader($data));');
    lines.push('    }');
    lines.push('');
    lines.push('    public static function deserialize(BorshReader $r): self');
    lines.push('    {');
    lines.push(`        $index = $r->${readMethod}();`);
    lines.push('        return match ($index) {');
    for (const variant of variants) {
        lines.push(`            ${variant.index} => ${variant.className}::deserializeFields($r),`);
    }
    lines.push(
        `            default => throw new SerializationException('Unknown ${className} variant index: ' . $index),`,
    );
    lines.push('        };');
    lines.push('    }');
    lines.push('}');
    return lines.join('\n');
}
