/**
 * Generated PHP code references runtime classes through a fixed set of
 * `use` statements emitted by the page templates and refers to other
 * generated types via fully-qualified names. This class is therefore a
 * minimal shim kept for API parity with the other Codama renderers.
 */
export class ImportMap {
    protected readonly _imports: Set<string> = new Set();

    get imports(): Set<string> {
        return this._imports;
    }

    add(imports: Set<string> | string[] | string): ImportMap {
        const newImports = typeof imports === 'string' ? [imports] : imports;
        newImports.forEach(i => this._imports.add(i));
        return this;
    }

    mergeWith(...others: ImportMap[]): ImportMap {
        others.forEach(other => this.add(other._imports));
        return this;
    }

    isEmpty(): boolean {
        return this._imports.size === 0;
    }

    toString(): string {
        return [...this._imports]
            .sort()
            .map(i => `use ${i};`)
            .join('\n');
    }
}
