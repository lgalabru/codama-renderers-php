import { logWarn } from '@codama/errors';
import {
    camelCase,
    getAllInstructionsWithSubs,
    getAllPrograms,
    InstructionNode,
    isNode,
    parseDocs,
    pascalCase,
    PdaNode,
    ProgramNode,
    resolveNestedTypeNode,
    VALUE_NODES,
} from '@codama/nodes';
import { addToRenderMap, createRenderMap, mergeRenderMaps } from '@codama/renderers-core';
import {
    extendVisitor,
    LinkableDictionary,
    NodeStack,
    pipe,
    recordLinkablesOnFirstVisitVisitor,
    recordNodeStackVisitor,
    staticVisitor,
    visit,
    Visitor,
} from '@codama/visitors-core';

import { getPhpField, getTypeManifestVisitor, TypeManifest } from './getTypeManifestVisitor';
import { renderValueNode } from './renderValueNodeVisitor';
import {
    buildDataClass,
    constantValueToBytes,
    getDiscriminatorConstants,
    getImportFromFactory,
    indentBlock,
    LinkOverrides,
    nullablePhpType,
    PhpClass,
    phpBytes,
    phpClassName,
    phpConstName,
    PhpField,
    phpMemberName,
    phpString,
    render,
    withVar,
} from './utils';

export type GetRenderMapOptions = {
    linkOverrides?: LinkOverrides;
    /**
     * Root namespace of the generated client.
     * Defaults to `Generated\<PascalCaseProgramName>`.
     */
    namespace?: string;
    renderParentInstructions?: boolean;
};

type RenderMapEntry = { content: string };

const SHARED_CLASSES = [
    'AccountMeta',
    'Borsh',
    'BorshReader',
    'ClientException',
    'Instruction',
    'Pda',
    'PdaException',
    'ProgramException',
    'Pubkey',
    'SerializationException',
] as const;

export function getRenderMapVisitor(options: GetRenderMapOptions = {}) {
    const linkables = new LinkableDictionary();
    const stack = new NodeStack();
    let program: ProgramNode | null = null;
    let programIndex = 0;
    let rootNamespace: string | null = null;

    const renderParentInstructions = options.renderParentInstructions ?? false;
    // Kept for parity with the other renderers; PHP generated code uses
    // fully qualified names so link overrides have no effect on imports.
    getImportFromFactory(options.linkOverrides ?? {});

    const ns = (): string => rootNamespace ?? 'Generated';
    const ensureNamespace = (programName: string) => {
        rootNamespace ??= options.namespace ?? `Generated\\${pascalCase(programName)}`;
    };
    const renderPage = (template: string, context: object): string =>
        render(template, context).replace(/%NS%/g, () => ns());
    const uses = (...names: string[]): string[] => names.map(name => `%NS%\\Shared\\${name}`);
    // Only emit `use` statements for shared classes actually referenced by the code.
    const usesFor = (content: string, ...names: string[]): string[] =>
        uses(...names.filter(name => new RegExp(`\\b${name}\\b`).test(content)));

    const nestedClassFiles = (nestedClasses: PhpClass[]): Record<string, RenderMapEntry> => {
        const files: Record<string, RenderMapEntry> = {};
        for (const nested of nestedClasses) {
            files[`Types/${nested.name}.php`] = {
                content: renderPage('definedTypesPage.njk', {
                    content: nested.code,
                    namespace: '%NS%\\Types',
                    uses: usesFor(nested.code, 'Borsh', 'BorshReader', 'Pubkey', 'SerializationException'),
                }),
            };
        }
        return files;
    };

    return pipe(
        staticVisitor(() => createRenderMap(), {
            keys: ['rootNode', 'programNode', 'instructionNode', 'accountNode', 'definedTypeNode'],
        }),
        v =>
            extendVisitor(v, {
                visitAccount(node) {
                    const className = phpClassName(node.name);
                    const fields = resolveNestedTypeNode(node.data).fields;
                    const nestedClasses: PhpClass[] = [];
                    const phpFields = fields.map(field => {
                        const phpField = getPhpField(field, className);
                        nestedClasses.push(...phpField.nestedClasses);
                        return phpField;
                    });

                    const constants = getDiscriminatorConstants({
                        discriminatorNodes: node.discriminators ?? [],
                        fields,
                    });
                    if (node.size != null) {
                        constants.push(`public const SIZE = ${node.size};`);
                    }

                    // PDA seed helper.
                    const pda = node.pda ? linkables.get([...stack.getPath(), node.pda]) : undefined;
                    const extraMethods: string[] = [];
                    if (pda) {
                        extraMethods.push(buildFindAddressMethod(className, pda, program?.publicKey ?? ''));
                    }

                    const classCode = buildDataClass({
                        className,
                        constants,
                        docs: parseDocs(node.docs),
                        extraMethods,
                        fields: phpFields,
                    });

                    return createRenderMap({
                        [`Accounts/${className}.php`]: {
                            content: renderPage('accountsPage.njk', {
                                content: classCode,
                                namespace: '%NS%\\Accounts',
                                uses: usesFor(classCode, 'Borsh', 'BorshReader', 'Pda', 'Pubkey'),
                            }),
                        },
                        ...nestedClassFiles(nestedClasses),
                    });
                },

                visitDefinedType(node) {
                    const typeManifestVisitor = getTypeManifestVisitor() as Visitor<TypeManifest>;
                    const manifest = visit(node, typeManifestVisitor);
                    const files: Record<string, RenderMapEntry> = {};
                    for (const nested of manifest.nestedClasses) {
                        files[`Types/${nested.name}.php`] = {
                            content: renderPage('definedTypesPage.njk', {
                                content: nested.code,
                                namespace: '%NS%\\Types',
                                uses: usesFor(nested.code, 'Borsh', 'BorshReader', 'Pubkey', 'SerializationException'),
                            }),
                        };
                    }
                    return createRenderMap(files);
                },

                visitInstruction(node) {
                    const className = phpClassName(node.name);

                    // Resolve account/argument name conflicts like the Go renderer.
                    const conflicts = getConflictsForInstructionAccountsAndArgs(node);
                    if (conflicts.length > 0) {
                        logWarn(
                            `[PHP] Accounts and args of instruction [${node.name}] have the following ` +
                                `conflicting attributes [${conflicts.join(', ')}]. ` +
                                `Thus, the conflicting arguments will be suffixed with "Arg". ` +
                                'You may want to rename the conflicting attributes.',
                        );
                    }

                    const nestedClasses: PhpClass[] = [];
                    const args = node.arguments.map(argument => {
                        const resolvedName = conflicts.includes(argument.name)
                            ? `${argument.name}Arg`
                            : argument.name;
                        const phpField = getPhpField({ ...argument, name: camelCase(resolvedName) }, className);
                        nestedClasses.push(...phpField.nestedClasses);
                        const hasDefaultValue =
                            !!argument.defaultValue && isNode(argument.defaultValue, VALUE_NODES);
                        const optional = hasDefaultValue && argument.defaultValueStrategy !== 'omitted';
                        return {
                            ...phpField,
                            defaultRender:
                                optional && argument.defaultValue
                                    ? renderValueNode(argument.defaultValue).render
                                    : null,
                            optional,
                        };
                    });

                    const constants = getDiscriminatorConstants({
                        discriminatorNodes: node.discriminators ?? [],
                        fields: node.arguments,
                    });

                    const classCode = buildDataClass({
                        className,
                        constants,
                        docs: parseDocs(node.docs),
                        extraMethods: [buildInstructionMethod(node, args, program?.publicKey ?? '')],
                        fields: args,
                    });

                    return createRenderMap({
                        [`Instructions/${className}.php`]: {
                            content: renderPage('instructionsPage.njk', {
                                content: classCode,
                                namespace: '%NS%\\Instructions',
                                uses: usesFor(classCode, 'AccountMeta', 'Borsh', 'BorshReader', 'Instruction', 'Pubkey'),
                            }),
                        },
                        ...nestedClassFiles(nestedClasses),
                    });
                },

                visitProgram(node, { self }) {
                    program = node;
                    ensureNamespace(node.name);
                    const isMainProgram = programIndex === 0;
                    programIndex += 1;

                    let renders = mergeRenderMaps([
                        ...node.accounts.map(account => visit(account, self)),
                        ...node.definedTypes.map(type => visit(type, self)),
                        ...getAllInstructionsWithSubs(node, {
                            leavesOnly: !renderParentInstructions,
                        }).map(ix => visit(ix, self)),
                    ]);

                    // Program file.
                    const programClassName = isMainProgram ? 'Program' : `${pascalCase(node.name)}Program`;
                    renders = addToRenderMap(renders, `${programClassName}.php`, {
                        content: renderPage('programsMod.njk', {
                            addressLiteral: phpString(node.publicKey),
                            className: programClassName,
                            nameLiteral: phpString(node.name),
                            namespace: '%NS%',
                            programName: pascalCase(node.name),
                            uses: uses('Pubkey'),
                        }),
                    });

                    // Errors file.
                    if (node.errors.length > 0) {
                        const errorsClassName = isMainProgram ? 'Errors' : `${pascalCase(node.name)}Errors`;
                        renders = addToRenderMap(renders, `${errorsClassName}.php`, {
                            content: renderPage('errorsPage.njk', {
                                className: errorsClassName,
                                errors: [...node.errors]
                                    .sort((a, b) => a.code - b.code)
                                    .map(error => ({
                                        code: error.code,
                                        constName: phpConstName(error.name),
                                        message: error.message,
                                        messageLiteral: phpString(error.message),
                                    })),
                                namespace: '%NS%',
                                programName: pascalCase(node.name),
                                uses: uses('ProgramException'),
                            }),
                        });
                    }

                    program = null;
                    return renders;
                },

                visitRoot(node, { self }) {
                    const programsToExport = getAllPrograms(node);
                    if (programsToExport.length > 0) {
                        ensureNamespace(programsToExport[0].name);
                    }

                    const sharedFiles: Record<string, RenderMapEntry> = {};
                    for (const sharedClass of SHARED_CLASSES) {
                        sharedFiles[`Shared/${sharedClass}.php`] = {
                            content: renderPage(`shared${sharedClass}Page.njk`, {
                                namespace: '%NS%\\Shared',
                            }),
                        };
                    }
                    sharedFiles['autoload.php'] = {
                        content: renderPage('rootMod.njk', {
                            prefixLiteral: phpString(`${ns()}\\`),
                        }),
                    };

                    return mergeRenderMaps([
                        createRenderMap(sharedFiles),
                        ...programsToExport.map(p => visit(p, self)),
                    ]);
                },
            }),
        v => recordNodeStackVisitor(v, stack),
        v => recordLinkablesOnFirstVisitVisitor(v, linkables),
    );
}

function getConflictsForInstructionAccountsAndArgs(instruction: InstructionNode): string[] {
    const allNames = [
        ...instruction.accounts.map(account => account.name),
        ...instruction.arguments.map(argument => argument.name),
    ];
    const duplicates = allNames.filter((e, i, a) => a.indexOf(e) !== i);
    return [...new Set(duplicates)];
}

/** Builds the static `findAddress` PDA helper method for an account with a linked PDA. */
function buildFindAddressMethod(className: string, pda: PdaNode, programAddress: string): string {
    const params: { docType: string; name: string; phpType: string }[] = [];
    const seedExpressions: string[] = [];

    for (const seed of pda.seeds) {
        if (isNode(seed, 'variablePdaSeedNode')) {
            const name = phpMemberName(seed.name);
            const visitor = getTypeManifestVisitor({
                parentName: `${className}${pascalCase(seed.name)}Seed`,
            }) as Visitor<TypeManifest>;
            const manifest = visit(seed.type, visitor);
            params.push({ docType: manifest.docType, name, phpType: manifest.phpType });
            seedExpressions.push(withVar(manifest.serialize, `$${name}`));
        } else if (isNode(seed.value, 'programIdValueNode')) {
            seedExpressions.push(`Pubkey::fromBase58(${phpString(programAddress)})->bytes`);
        } else {
            const bytes = constantValueToBytes(seed.type, seed.value);
            if (bytes === null) {
                throw new Error(`Unsupported constant PDA seed for account [${className}].`);
            }
            seedExpressions.push(phpBytes(bytes));
        }
    }

    const docLines = [
        '/**',
        ` * Finds the PDA of the \`${className}\` account and its bump seed.`,
        ' *',
        ...params
            .filter(param => param.docType !== param.phpType)
            .map(param => ` * @param ${param.docType} $${param.name}`),
        ' * @return array{0: Pubkey, 1: int}',
        ' */',
    ];
    const signatureParams = params.map(param => `${param.phpType} $${param.name}`).join(', ');
    const lines = [
        ...docLines,
        `public static function findAddress(${signatureParams}): array`,
        '{',
        '    return Pda::findProgramAddress([',
        ...seedExpressions.map(expression => `        ${expression},`),
        `    ], Pubkey::fromBase58(${phpString(programAddress)}));`,
        '}',
    ];
    return lines.join('\n');
}

type InstructionArg = PhpField & { defaultRender: string | null; optional: boolean };

/** Builds the static `instruction` builder method of an instruction class. */
function buildInstructionMethod(node: InstructionNode, args: InstructionArg[], programAddress: string): string {
    const accounts = node.accounts.map(account => ({
        isOptional: account.isOptional,
        isSigner: account.isSigner === true,
        isWritable: account.isWritable,
        name: phpMemberName(account.name),
        rawName: account.name,
    }));
    const optionalAccountStrategy = node.optionalAccountStrategy ?? 'programId';

    const requiredAccounts = accounts.filter(account => !account.isOptional);
    const optionalAccounts = accounts.filter(account => account.isOptional);
    const requiredArgs = args.filter(arg => !arg.omitted && !arg.optional);
    const optionalArgs = args.filter(arg => arg.optional);

    // Parameters: required accounts, required args, optional accounts, optional args.
    const params: string[] = [
        ...requiredAccounts.map(account => `Pubkey $${account.name}`),
        ...requiredArgs.map(arg => `${arg.phpType} $${arg.name}`),
        ...optionalAccounts.map(account => `?Pubkey $${account.name} = null`),
        ...optionalArgs.map(arg => `${nullablePhpType(arg.phpType)} $${arg.name} = null`),
    ];

    const docLines: string[] = [
        '/**',
        ` * Builds a \`${pascalCase(node.name)}\` instruction.`,
        ' *',
        ...requiredAccounts.map(account => ` * @param Pubkey $${account.name} Account.`),
        ...requiredArgs.map(arg => ` * @param ${arg.docType} $${arg.name} Argument.`),
        ...optionalAccounts.map(account => ` * @param Pubkey|null $${account.name} Optional account.`),
        ...optionalArgs.map(
            arg => ` * @param ${arg.docType}|null $${arg.name} Optional argument (defaults to ${arg.defaultRender}).`,
        ),
        ' */',
    ];

    const body: string[] = ['$accounts = [];'];
    for (const account of accounts) {
        const meta = (pubkey: string) =>
            `new AccountMeta(${pubkey}, ${account.isSigner ? 'true' : 'false'}, ${account.isWritable ? 'true' : 'false'})`;
        if (!account.isOptional) {
            body.push(`$accounts[] = ${meta(`$${account.name}`)};`);
        } else if (optionalAccountStrategy === 'omitted') {
            body.push(`if ($${account.name} !== null) {`);
            body.push(`    $accounts[] = ${meta(`$${account.name}`)};`);
            body.push('}');
        } else {
            // Default 'programId' strategy: use the program ID as a non-signer,
            // non-writable placeholder when the account is not provided.
            body.push(`$accounts[] = $${account.name} !== null`);
            body.push(`    ? ${meta(`$${account.name}`)}`);
            body.push(
                `    : new AccountMeta(Pubkey::fromBase58(${phpString(programAddress)}), false, false);`,
            );
        }
    }
    const ctorArgs = args
        .filter(arg => !arg.omitted)
        .map(arg => (arg.optional ? `$${arg.name} ?? ${arg.defaultRender}` : `$${arg.name}`))
        .join(', ');
    body.push(`$data = (new self(${ctorArgs}))->serialize();`);
    body.push(`return new Instruction(Pubkey::fromBase58(${phpString(programAddress)}), $accounts, $data);`);

    return [
        ...docLines,
        `public static function instruction(${params.join(', ')}): Instruction`,
        '{',
        indentBlock(body.join('\n'), '    '),
        '}',
    ].join('\n');
}
