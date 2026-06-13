# Codama ➤ Renderers ➤ PHP

[![npm][npm-image]][npm-url]
[![npm-downloads][npm-downloads-image]][npm-url]

[npm-downloads-image]: https://img.shields.io/npm/dm/@codama/renderers-php.svg?style=flat
[npm-image]: https://img.shields.io/npm/v/@codama/renderers-php.svg?style=flat&label=%40codama%2Frenderers-php
[npm-url]: https://www.npmjs.com/package/@codama/renderers-php

This package generates self-contained PHP clients from your Codama IDLs — no Composer dependencies required.

## Installation

```sh
pnpm install @codama/renderers-php
```

## Usage

Once you have a Codama IDL, you can use the `renderVisitor` of this package to generate PHP clients:

```ts
import { renderVisitor } from '@codama/renderers-php';

const pathToGeneratedFolder = path.join(__dirname, 'clients', 'php', 'generated');
const options = {}; // See below.
codama.accept(renderVisitor(pathToGeneratedFolder, options));
```

The following options can be provided to the `renderVisitor`:

| Name                          | Type                                                  | Default                                | Description                                                                                                |
| ----------------------------- | ----------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `deleteFolderBeforeRendering` | `boolean`                                             | `true`                                 | Whether the base folder should be cleaned before generating new files.                                      |
| `formatCode`                  | `boolean`                                             | `true`                                 | Whether to run `php -l` on every generated file (skipped gracefully when PHP is not installed).             |
| `namespace`                   | `string`                                              | `Generated\<PascalCaseProgramName>`    | The root PHP namespace of the generated client.                                                             |
| `linkOverrides`               | `Record<'accounts' \| 'definedTypes' \| ..., string>` | `{}`                                   | Kept for API parity with the other renderers (generated PHP uses fully qualified names).                    |
| `renderParentInstructions`    | `boolean`                                             | `false`                                | When using nested instructions, whether the parent instructions should also be rendered.                    |

## Generated client

The renderer emits a PSR-4 style tree, one class per file, plus a simple `autoload.php` so the client works without Composer:

```
generated/
├── autoload.php           # spl_autoload_register-based autoloader
├── Program.php            # Program ID constant and helper
├── Errors.php             # Error code constants + code → message lookup
├── Accounts/<Name>.php    # Account data classes (Borsh round-trip, PDA helpers)
├── Instructions/<Name>.php# Instruction data classes + static instruction() builders
├── Types/<Name>.php       # Structs, PHP 8.1 enums, data enums (one class per variant)
└── Shared/                # Self-contained runtime: Borsh, BorshReader, Pubkey, Pda, Instruction, AccountMeta
```

```php
require 'generated/autoload.php';

use Generated\System\Instructions\TransferSol;
use Generated\System\Shared\Pubkey;

$ix = TransferSol::instruction(
    source: Pubkey::fromBase58('...'),
    destination: Pubkey::fromBase58('...'),
    amount: 1_000_000,
);
// $ix->programId, $ix->accounts (AccountMeta[]), $ix->data (binary string)
```

### Requirements and conventions

- **PHP 8.1+** with the **GMP extension** (`ext-gmp`). GMP is used for base58, PDA derivation (ed25519 on-curve check) and 64/128-bit integer arithmetic. The renderer deliberately targets 8.1: constructor property promotion plus `readonly` properties already make every generated data class immutable, so PHP 8.2 `readonly` classes are not required.
- **Code style**: PSR-1 / PSR-12 / PER-CS 2.0. Every generated file starts with `declare(strict_types=1);`, declares full parameter/return/property types, and holds one class per file. Generated output is kept clean against `php-cs-fixer` (PER-CS 2.0 ruleset) and `phpstan --level=max` (see below).
- **Data classes**: constructor property promotion with `public readonly` properties everywhere; value objects (`Pubkey`, `AccountMeta`, `Instruction`) are immutable.
- **Exceptions**: the runtime ships an explicit hierarchy under `Shared/` — `ClientException` (base, extends `\RuntimeException`), `SerializationException` (truncated data, unknown enum variants), `PdaException` (on-curve seeds, bump exhaustion) and `ProgramException` (program error with a readonly `errorCode`). The generated `Errors` class maps codes to messages (`Errors::message($code)`) and to throwable exceptions (`Errors::exception($code)`). Invalid caller input throws the SPL `\InvalidArgumentException`.
- Integers: `u8`–`u32` and `i8`–`i64` are PHP `int`; `u64`/`u128`/`i128` are `int|numeric-string` (decimal strings beyond `int` range; `\GMP` instances also accepted on write).
- Bytes and fixed strings are raw PHP binary strings; `Pubkey` wraps 32 bytes with base58 helpers.
- Scalar enums are native PHP backed enums; data enums are an abstract base class plus one final subclass per variant (`VARIANT_INDEX` constant).
- Accounts/instructions expose `serialize(): string`, `static fromBytes(string)`, `static deserialize(BorshReader)`, discriminator constants and, for PDA-linked accounts, a `static findAddress(...): array{Pubkey, int}` helper.

## Unit tests and TypeScript coverage

```sh
pnpm test:unit
```

Runs the vitest suite over the renderer source (`src/`) with **enforced V8 coverage thresholds**: at least **90% lines, statements and functions** and **95% branches** (the suite currently sits at ~99% lines / ~96% branches). The thresholds live in `vitest.config.mts`; the run fails when coverage drops below them.

## E2E tests

```sh
pnpm build && pnpm test:e2e
```

This generates clients for the `dummy`, `system`, `memo` and `pump-fun` fixtures, runs `php -l` on every generated file, executes `e2e/smoke.php` (instruction building, Borsh round-trips, base58 and PDA derivation against `@solana/web3.js` test vectors, exception hierarchy), and runs the conformance suite described below.

The e2e run also style-checks, static-analyzes and coverage-checks all generated fixture output when the PHP tooling is installed (and skips gracefully otherwise):

```sh
composer install -d tools   # installs php-cs-fixer, phpstan and phpunit (gitignored vendor)
```

- `php-cs-fixer` uses `.php-cs-fixer.dist.php` (PER-CS 2.0 + enforced `declare_strict_types`) over the generated output, the smoke test, the conformance runner and the phpunit suite.
- `phpstan` uses `phpstan.neon` at **level max** (with `phpVersion: 8.1`) over the same files and passes with no ignore rules. The only suppressions live in the `BorshReader` template: three inline `@var numeric-string` annotations narrowing `gmp_strval()` results (it provably returns decimal digit strings) and four inline `@var` annotations on `unpack()` results whose format strings are constant and therefore cannot fail.

## Conformance vectors

`e2e/conformance_runner.php` executes the shared cross-language test-vector corpus living at `<repo>/conformance/vectors/*.json` (borsh, base58, sha256, pda, instruction and account modes) against the **generated** fixture clients, printing passed/failed/skipped counts per mode and exiting non-zero on any failure. When the corpus directory is absent the runner warns and exits 0.

```sh
php -d zend.assertions=1 -d assert.exception=1 e2e/conformance_runner.php
```

Decisions on the corpus's implementation-defined (`optional: true`) vectors:

| Vector | Decision |
| --- | --- |
| `borsh-option-bad-flag` | **Skipped** — the generated `readOption()` is lenient and treats any non-zero flag byte as *some*. |
| `borsh-option-nested-some-none` | **Skipped** — the runtime uses `null` as the *none* sentinel, so `some(none)` is not representable. |
| `borsh-shortu16-alias-accepted` | **Asserted** — aliased (non-canonical) shortU16 encodings decode; over-long (4+ byte) and truncated encodings are still rejected, satisfying the required error vectors. |
| `borsh-{map,set}-unordered-input-canonicalized` | **Skipped** — the generated writers preserve insertion order rather than sorting on encode (corpus inputs are pre-sorted, so all required vectors pass). |
| `ix-pump-buy-default-program-accounts` | **Skipped** — generated builders take every account explicitly and do not resolve constant default accounts. |
| `account-system-nonce-unknown-enum-variant` | **Asserted** — scalar enums are PHP backed enums, so unknown variant indexes are rejected (`\ValueError`). |

The sha256 vectors assert PHP's bundled `ext-hash` (`\hash('sha256', ...)`) — the exact primitive the generated `Shared/Pda.php` calls.

## Generated-PHP coverage

When phpunit is installed (`composer install -d tools`), `pnpm test:e2e` additionally runs the conformance vectors, the smoke test and a dedicated runtime sweep (`e2e/phpunit/`) under phpunit with **pcov** coverage, then `tools/check-coverage.php` enforces **at least 90% line coverage on the generated `Shared/` runtime** (currently ~95%) and reports line coverage of the full generated tree. The only intentionally uncovered runtime lines are the `ensureGmp()` throws (ext-gmp is required to run the suite at all) and the bump-exhausted throw of `Pda::findProgramAddress()`.

```sh
php -d zend.assertions=1 -d assert.exception=1 -d pcov.enabled=1 -d pcov.directory=e2e \
    tools/vendor/bin/phpunit --configuration tools/phpunit.xml \
    --coverage-clover e2e/phpunit/coverage/clover.xml
php tools/check-coverage.php e2e/phpunit/coverage/clover.xml
```
