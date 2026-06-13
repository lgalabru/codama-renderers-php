<?php

/**
 * Conformance runner for the shared cross-language vector corpus living in
 * `<repo>/conformance/vectors/*.json`.
 *
 * The runner loads every vector file, dispatches on each vector's `mode`
 * (borsh | base58 | sha256 | pda | instruction | account) and asserts the
 * pinned oracle against the GENERATED runtime of the e2e fixture clients
 * (system, memo, pump-fun and dummy — generate them with `e2e/generate.cjs`
 * first). It prints passed/failed/skipped counts per mode and exits non-zero
 * on any failure.
 *
 * Run with: php -d zend.assertions=1 -d assert.exception=1 e2e/conformance_runner.php
 *
 * Implementation-defined (`optional: true`) vectors, documented decisions:
 * - `borsh-option-bad-flag` is SKIPPED: the generated `readOption()` is
 *   lenient and treats any non-zero flag byte as "some".
 * - `borsh-option-nested-some-none` is SKIPPED: the runtime uses `null` as
 *   the none sentinel, so `some(none)` is not representable.
 * - `borsh-{map,set}-unordered-input-canonicalized` are SKIPPED: the
 *   generated writers preserve insertion order instead of sorting.
 * - `borsh-shortu16-alias-accepted` is ASSERTED: aliased (non-canonical)
 *   shortU16 encodings decode fine today; over-long (4+ byte) and truncated
 *   encodings are still rejected, matching the required error vectors.
 * - `ix-pump-buy-default-program-accounts` is SKIPPED: the generated
 *   builders take every account explicitly and do not resolve constant
 *   public-key defaults.
 * - `account-system-nonce-unknown-enum-variant` is ASSERTED: scalar enums
 *   are PHP backed enums, so unknown variant indexes raise a `\ValueError`.
 *
 * Note on sha256: the generated runtime delegates hashing to PHP's bundled
 * ext-hash (`\hash('sha256', ...)` inside `Shared/Pda.php`), so the sha256
 * vectors assert that exact primitive.
 */

declare(strict_types=1);

namespace Codama\Conformance;

use Generated\Dummy\Instructions\Instruction3;
use Generated\Dummy\Instructions\Instruction5;
use Generated\Memo\Instructions\AddMemo;
use Generated\Pump\Accounts\BondingCurve;
use Generated\Pump\Accounts\FeeConfig;
use Generated\Pump\Instructions\Buy;
use Generated\Pump\Instructions\Create;
use Generated\Pump\Shared\Pubkey as PumpPubkey;
use Generated\Pump\Types\Fees;
use Generated\Pump\Types\FeeTier;
use Generated\Pump\Types\OptionBool;
use Generated\System\Accounts\Nonce;
use Generated\System\Instructions\CreateAccountWithSeed;
use Generated\System\Instructions\TransferSol;
use Generated\System\Shared\Borsh;
use Generated\System\Shared\BorshReader;
use Generated\System\Shared\Pda;
use Generated\System\Shared\Pubkey;
use Generated\System\Types\NonceState;
use Generated\System\Types\NonceVersion;

foreach (['system', 'memo', 'pump-fun', 'dummy'] as $fixture) {
    $autoload = __DIR__ . '/' . $fixture . '/generated/autoload.php';
    if (!\is_file($autoload)) {
        \fwrite(\STDERR, "Missing generated fixture client: {$autoload}\n");
        \fwrite(\STDERR, "Generate it first with: ./e2e/generate.cjs {$fixture}\n");
        exit(1);
    }
    require_once $autoload;
}

/** A vector failed: the runtime disagrees with the pinned oracle. */
final class VectorFailure extends \RuntimeException {}

/** A vector exercises behavior this runtime intentionally does not provide. */
final class VectorSkipped extends \RuntimeException {}

final class ConformanceRunner
{
    /**
     * `optional: true` vectors this runtime cannot honor, with the reason
     * reported in the skip summary. See the file docblock for details.
     */
    private const SKIPPED_VECTOR_IDS = [
        'borsh-option-bad-flag' => 'readOption() is lenient: any non-zero flag byte decodes as some',
        'borsh-map-unordered-input-canonicalized' => 'Borsh::map() preserves insertion order (no sort on encode)',
        'borsh-set-unordered-input-canonicalized' => 'Borsh::vec() preserves insertion order (no sort on encode)',
        'ix-pump-buy-default-program-accounts' => 'builders take all accounts explicitly (no constant default resolution)',
    ];

    /** @var array<string, array{passed: int, failed: int, skipped: int}> */
    private array $stats = [];

    /** @var list<string> */
    private array $failures = [];

    /** @var list<string> */
    private array $skips = [];

    public function __construct(private readonly string $vectorsDir) {}

    public static function main(): int
    {
        $vectorsDir = \dirname(__DIR__, 2) . '/conformance/vectors';
        if (!\is_dir($vectorsDir)) {
            \fwrite(\STDERR, "WARNING: conformance corpus not found at {$vectorsDir}; skipping conformance tests.\n");

            return 0;
        }

        return (new self($vectorsDir))->run();
    }

    public function run(): int
    {
        $files = \glob($this->vectorsDir . '/*.json');
        if ($files === false || $files === []) {
            \fwrite(\STDERR, "WARNING: no vector files found in {$this->vectorsDir}; skipping conformance tests.\n");

            return 0;
        }
        \sort($files);

        foreach ($files as $file) {
            foreach ($this->loadVectors($file) as $vector) {
                $this->runVector(self::asMap($vector));
            }
        }

        return $this->printSummary();
    }

    /** Total number of failed vectors so far. */
    public function failureCount(): int
    {
        $failed = 0;
        foreach ($this->stats as $modeStats) {
            $failed += $modeStats['failed'];
        }

        return $failed;
    }

    /** @return list<mixed> */
    private function loadVectors(string $file): array
    {
        $json = \file_get_contents($file);
        if ($json === false) {
            throw new \RuntimeException('Cannot read vector file: ' . $file);
        }
        $vectors = \json_decode($json, true, 512, \JSON_THROW_ON_ERROR);
        if (!\is_array($vectors) || !\array_is_list($vectors)) {
            throw new \RuntimeException('Vector file is not a JSON array: ' . $file);
        }

        return $vectors;
    }

    /** @param array<string, mixed> $vector */
    private function runVector(array $vector): void
    {
        $id = self::asString($vector['id'] ?? null);
        $mode = self::asString($vector['mode'] ?? null);
        $this->stats[$mode] ??= ['failed' => 0, 'passed' => 0, 'skipped' => 0];

        try {
            $skipReason = self::SKIPPED_VECTOR_IDS[$id] ?? null;
            if ($skipReason !== null) {
                throw new VectorSkipped($skipReason);
            }
            $input = self::asMap($vector['input'] ?? null);
            $expected = self::asMap($vector['expected'] ?? null);
            match ($mode) {
                'borsh' => $this->runBorsh($input, $expected),
                'base58' => $this->runBase58($input, $expected),
                'sha256' => $this->runSha256($input, $expected),
                'pda' => $this->runPda($input, $expected),
                'instruction' => $this->runInstruction($input, $expected),
                'account' => $this->runAccount($input, $expected),
                default => throw new VectorSkipped('unknown mode: ' . $mode),
            };
            $this->stats[$mode]['passed']++;
        } catch (VectorSkipped $skipped) {
            $this->stats[$mode]['skipped']++;
            $this->skips[] = "[{$mode}] {$id}: {$skipped->getMessage()}";
        } catch (VectorFailure $failure) {
            $this->stats[$mode]['failed']++;
            $this->failures[] = "[{$mode}] {$id}: {$failure->getMessage()}";
        } catch (\Throwable $crash) {
            $this->stats[$mode]['failed']++;
            $this->failures[] = "[{$mode}] {$id}: crashed with " . $crash::class . ': ' . $crash->getMessage();
        }
    }

    private function printSummary(): int
    {
        foreach ($this->skips as $skip) {
            echo "SKIP {$skip}\n";
        }
        foreach ($this->failures as $failure) {
            echo "FAIL {$failure}\n";
        }
        $totals = ['failed' => 0, 'passed' => 0, 'skipped' => 0];
        \ksort($this->stats);
        foreach ($this->stats as $mode => $modeStats) {
            \printf(
                "%-12s %3d passed, %3d failed, %3d skipped\n",
                $mode . ':',
                $modeStats['passed'],
                $modeStats['failed'],
                $modeStats['skipped'],
            );
            $totals['passed'] += $modeStats['passed'];
            $totals['failed'] += $modeStats['failed'];
            $totals['skipped'] += $modeStats['skipped'];
        }
        \printf("%-12s %3d passed, %3d failed, %3d skipped\n", 'total:', $totals['passed'], $totals['failed'], $totals['skipped']);
        if ($totals['failed'] > 0) {
            echo "Conformance FAILED.\n";

            return 1;
        }
        if ($totals['passed'] === 0) {
            \fwrite(\STDERR, "WARNING: no conformance vectors were executed.\n");

            return 0;
        }
        echo "All conformance vectors passed.\n";

        return 0;
    }

    // -----------------------------------------------------------------------
    // Mode: borsh
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runBorsh(array $input, array $expected): void
    {
        $type = $input['type'] ?? null;
        $direction = isset($input['direction']) ? self::asString($input['direction']) : null;

        if ($direction === 'decode') {
            $bytes = self::hexToBin(self::asString($input['hex'] ?? null));
            if (self::expectsError($expected)) {
                $this->expectTypedError(function () use ($type, $bytes): void {
                    $this->decodeCanonical($type, new BorshReader($bytes));
                });

                return;
            }
            $reader = new BorshReader($bytes);
            $decoded = $this->decodeCanonical($type, $reader);
            self::assertSame($this->canonicalPortable($type, $expected['value'] ?? null), $decoded, 'decoded value');

            return;
        }

        $expectedHex = self::asString($expected['hex'] ?? null);
        $encoded = $this->encode($type, $input['value'] ?? null);
        self::assertSame($expectedHex, \bin2hex($encoded), 'encoded bytes');

        if ($direction === 'encode') {
            return;
        }

        // Round-trip: also decode the expected bytes and compare values.
        $reader = new BorshReader(self::hexToBin($expectedHex));
        $decoded = $this->decodeCanonical($type, $reader);
        if ($reader->remaining() !== 0) {
            throw new VectorFailure('decode left ' . $reader->remaining() . ' unread byte(s)');
        }
        self::assertSame($this->canonicalPortable($type, $input['value'] ?? null), $decoded, 'round-tripped value');
    }

    /** Encodes a portable value with the generated Borsh runtime, guided by a type descriptor. */
    private function encode(mixed $type, mixed $value): string
    {
        if (\is_string($type)) {
            return match ($type) {
                'u8' => Borsh::u8(self::asInt($value)),
                'u16' => Borsh::u16(self::asInt($value)),
                'u32' => Borsh::u32(self::asInt($value)),
                'u64' => Borsh::u64(self::asIntLike($value)),
                'u128' => Borsh::u128(self::asIntLike($value)),
                'i8' => Borsh::i8(self::asInt($value)),
                'i16' => Borsh::i16(self::asInt($value)),
                'i32' => Borsh::i32(self::asInt($value)),
                'i64' => Borsh::i64(self::asIntLike($value)),
                'i128' => Borsh::i128(self::asIntLike($value)),
                'f32' => Borsh::f32(self::asFloat($value)),
                'f64' => Borsh::f64(self::asFloat($value)),
                'bool' => Borsh::bool(self::asBool($value)),
                'shortu16' => Borsh::shortU16(self::asInt($value)),
                'string' => Borsh::str(self::asString($value)),
                'bytes' => Borsh::bytes(self::hexToBin(self::asString($value))),
                'pubkey' => Pubkey::fromBase58(self::asString($value))->bytes,
                default => throw new VectorSkipped('unsupported type descriptor: ' . $type),
            };
        }

        $descriptor = self::asMap($type);
        if (\array_key_exists('option', $descriptor)) {
            if ($value === null) {
                return Borsh::option(null, static fn(mixed $item): string => '');
            }
            $some = self::asMap($value);
            if (!\array_key_exists('some', $some)) {
                throw new VectorFailure('option value must be null or {"some": ...}');
            }
            if ($some['some'] === null) {
                throw new VectorSkipped('some(none) is not representable: the runtime uses null as the none sentinel');
            }

            return Borsh::option($some['some'], fn(mixed $item): string => $this->encode($descriptor['option'], $item));
        }
        if (\array_key_exists('fixedBytes', $descriptor)) {
            $size = self::asInt($descriptor['fixedBytes']);

            return Borsh::fixedBytes(self::hexToBin(self::asString($value)), $size);
        }
        if (\array_key_exists('vec', $descriptor)) {
            return Borsh::vec(self::asList($value), fn(mixed $item): string => $this->encode($descriptor['vec'], $item));
        }
        if (\array_key_exists('array', $descriptor)) {
            $array = self::asMap($descriptor['array']);

            return Borsh::vec(
                self::asList($value),
                fn(mixed $item): string => $this->encode($array['item'] ?? null, $item),
                self::asInt($array['size'] ?? null),
            );
        }
        if (\array_key_exists('set', $descriptor)) {
            return Borsh::vec(self::asList($value), fn(mixed $item): string => $this->encode($descriptor['set'], $item));
        }
        if (\array_key_exists('map', $descriptor)) {
            $map = self::asMap($descriptor['map']);
            $entries = [];
            foreach (self::asList($value) as $pair) {
                $pair = self::asList($pair);
                $entries[self::asArrayKey($pair[0] ?? null)] = $pair[1] ?? null;
            }

            return Borsh::map(
                $entries,
                fn(mixed $key): string => $this->encode($map['key'] ?? null, $key),
                fn(mixed $item): string => $this->encode($map['value'] ?? null, $item),
            );
        }
        if (\array_key_exists('tuple', $descriptor)) {
            $items = self::asList($value);
            $out = '';
            foreach (self::asList($descriptor['tuple']) as $index => $itemType) {
                $out .= $this->encode($itemType, $items[$index] ?? null);
            }

            return $out;
        }
        throw new VectorSkipped('unsupported type descriptor: ' . \json_encode($descriptor, \JSON_THROW_ON_ERROR));
    }

    /**
     * Decodes a value with the generated BorshReader, guided by a type
     * descriptor, and returns it in canonical form (see canonicalPortable).
     */
    private function decodeCanonical(mixed $type, BorshReader $r): mixed
    {
        if (\is_string($type)) {
            return match ($type) {
                'u8' => (string) $r->readU8(),
                'u16' => (string) $r->readU16(),
                'u32' => (string) $r->readU32(),
                'u64' => (string) $r->readU64(),
                'u128' => (string) $r->readU128(),
                'i8' => (string) $r->readI8(),
                'i16' => (string) $r->readI16(),
                'i32' => (string) $r->readI32(),
                'i64' => (string) $r->readI64(),
                'i128' => (string) $r->readI128(),
                'f32' => $r->readF32(),
                'f64' => $r->readF64(),
                'bool' => $r->readBool(),
                'shortu16' => (string) $r->readShortU16(),
                'string' => $r->readString(),
                'bytes' => \bin2hex($r->readBytes()),
                'pubkey' => (new Pubkey($r->read(32)))->toBase58(),
                default => throw new VectorSkipped('unsupported type descriptor: ' . $type),
            };
        }

        $descriptor = self::asMap($type);
        if (\array_key_exists('option', $descriptor)) {
            return $r->readOption(fn(): mixed => $this->decodeCanonical($descriptor['option'], $r));
        }
        if (\array_key_exists('fixedBytes', $descriptor)) {
            return \bin2hex($r->read(self::asInt($descriptor['fixedBytes'])));
        }
        if (\array_key_exists('vec', $descriptor)) {
            return $r->readVec(fn(): mixed => $this->decodeCanonical($descriptor['vec'], $r));
        }
        if (\array_key_exists('array', $descriptor)) {
            $array = self::asMap($descriptor['array']);

            return $r->readVec(
                fn(): mixed => $this->decodeCanonical($array['item'] ?? null, $r),
                self::asInt($array['size'] ?? null),
            );
        }
        if (\array_key_exists('set', $descriptor)) {
            return $r->readVec(fn(): mixed => $this->decodeCanonical($descriptor['set'], $r));
        }
        if (\array_key_exists('map', $descriptor)) {
            $map = self::asMap($descriptor['map']);
            $assoc = $r->readMap(
                fn(): int|string => self::asArrayKey($this->decodeCanonical($map['key'] ?? null, $r)),
                fn(): mixed => $this->decodeCanonical($map['value'] ?? null, $r),
            );
            $pairs = [];
            foreach ($assoc as $key => $item) {
                $pairs[] = [(string) $key, $item];
            }

            return $pairs;
        }
        if (\array_key_exists('tuple', $descriptor)) {
            $items = [];
            foreach (self::asList($descriptor['tuple']) as $itemType) {
                $items[] = $this->decodeCanonical($itemType, $r);
            }

            return $items;
        }
        throw new VectorSkipped('unsupported type descriptor: ' . \json_encode($descriptor, \JSON_THROW_ON_ERROR));
    }

    /**
     * Converts a portable JSON value to the canonical comparison form:
     * integers become decimal strings, floats stay floats, byte blobs are
     * lowercase hex, pubkeys are base58, options collapse to null/value,
     * maps become lists of [key, value] pairs with string keys.
     */
    private function canonicalPortable(mixed $type, mixed $value): mixed
    {
        if (\is_string($type)) {
            return match ($type) {
                'u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128', 'shortu16' => (string) self::asIntLike($value),
                'f32', 'f64' => self::asFloat($value),
                'bool' => self::asBool($value),
                'string', 'pubkey' => self::asString($value),
                'bytes' => \strtolower(self::asString($value)),
                default => throw new VectorSkipped('unsupported type descriptor: ' . $type),
            };
        }

        $descriptor = self::asMap($type);
        if (\array_key_exists('option', $descriptor)) {
            if ($value === null) {
                return null;
            }
            $some = self::asMap($value);
            if ($some['some'] === null) {
                throw new VectorSkipped('some(none) is not representable: the runtime uses null as the none sentinel');
            }

            return $this->canonicalPortable($descriptor['option'], $some['some']);
        }
        if (\array_key_exists('fixedBytes', $descriptor)) {
            return \strtolower(self::asString($value));
        }
        foreach (['vec', 'set'] as $listKind) {
            if (\array_key_exists($listKind, $descriptor)) {
                return \array_map(
                    fn(mixed $item): mixed => $this->canonicalPortable($descriptor[$listKind], $item),
                    self::asList($value),
                );
            }
        }
        if (\array_key_exists('array', $descriptor)) {
            $array = self::asMap($descriptor['array']);

            return \array_map(
                fn(mixed $item): mixed => $this->canonicalPortable($array['item'] ?? null, $item),
                self::asList($value),
            );
        }
        if (\array_key_exists('map', $descriptor)) {
            $map = self::asMap($descriptor['map']);
            $pairs = [];
            foreach (self::asList($value) as $pair) {
                $pair = self::asList($pair);
                $key = $this->canonicalPortable($map['key'] ?? null, $pair[0] ?? null);
                $pairs[] = [\is_scalar($key) ? (string) $key : $key, $this->canonicalPortable($map['value'] ?? null, $pair[1] ?? null)];
            }

            return $pairs;
        }
        if (\array_key_exists('tuple', $descriptor)) {
            $items = [];
            foreach (self::asList($descriptor['tuple']) as $index => $itemType) {
                $items[] = $this->canonicalPortable($itemType, self::asList($value)[$index] ?? null);
            }

            return $items;
        }
        throw new VectorSkipped('unsupported type descriptor: ' . \json_encode($descriptor, \JSON_THROW_ON_ERROR));
    }

    // -----------------------------------------------------------------------
    // Mode: base58
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runBase58(array $input, array $expected): void
    {
        $base58 = self::asString($input['base58'] ?? null);
        $as = self::asString($input['as'] ?? null);

        if (self::expectsError($expected)) {
            $this->expectTypedError(static function () use ($as, $base58): void {
                if ($as === 'pubkey') {
                    Pubkey::fromBase58($base58);
                } else {
                    Pubkey::base58Decode($base58);
                }
            });

            return;
        }

        $bytes = self::hexToBin(self::asString($expected['hex'] ?? null));
        if ($as === 'pubkey') {
            self::assertSame(\bin2hex($bytes), \bin2hex(Pubkey::fromBase58($base58)->bytes), 'decoded pubkey bytes');
            self::assertSame($base58, (new Pubkey($bytes))->toBase58(), 're-encoded pubkey');
        } else {
            self::assertSame(\bin2hex($bytes), \bin2hex(Pubkey::base58Decode($base58)), 'decoded bytes');
            self::assertSame($base58, Pubkey::base58Encode($bytes), 're-encoded base58');
        }
    }

    // -----------------------------------------------------------------------
    // Mode: sha256
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runSha256(array $input, array $expected): void
    {
        if (\array_key_exists('repeat', $input)) {
            $repeat = self::asMap($input['repeat']);
            $message = \str_repeat(self::asString($repeat['utf8'] ?? null), self::asInt($repeat['count'] ?? null));
        } elseif (\array_key_exists('hex', $input)) {
            $message = self::hexToBin(self::asString($input['hex']));
        } else {
            $message = self::asString($input['utf8'] ?? null);
        }
        // The generated runtime hashes through PHP's bundled ext-hash — the
        // very call `Shared/Pda.php` makes — so assert that primitive.
        self::assertSame(self::asString($expected['hex'] ?? null), \hash('sha256', $message), 'sha256 digest');
    }

    // -----------------------------------------------------------------------
    // Mode: pda
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runPda(array $input, array $expected): void
    {
        $op = self::asString($input['op'] ?? null);

        if ($op === 'isOnCurve') {
            $onCurve = Pda::isOnCurve(self::hexToBin(self::asString($input['bytes'] ?? null)));
            self::assertSame(self::asBool($expected['onCurve'] ?? null), $onCurve, 'isOnCurve');

            return;
        }

        $seeds = [];
        foreach (self::asList($input['seeds'] ?? null) as $seed) {
            $seeds[] = self::hexToBin(self::asString($seed));
        }
        $programId = Pubkey::fromBase58(self::asString($input['programId'] ?? null));

        if ($op === 'findProgramAddress') {
            [$address, $bump] = Pda::findProgramAddress($seeds, $programId);
            self::assertSame(self::asString($expected['address'] ?? null), $address->toBase58(), 'derived address');
            self::assertSame(self::asInt($expected['bump'] ?? null), $bump, 'bump seed');

            return;
        }
        if ($op !== 'createProgramAddress') {
            throw new VectorSkipped('unsupported pda op: ' . $op);
        }
        if (self::expectsError($expected)) {
            $this->expectTypedError(static function () use ($seeds, $programId): void {
                Pda::createProgramAddress($seeds, $programId);
            });

            return;
        }
        $address = Pda::createProgramAddress($seeds, $programId);
        self::assertSame(self::asString($expected['address'] ?? null), $address->toBase58(), 'created address');
    }

    // -----------------------------------------------------------------------
    // Mode: instruction
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runInstruction(array $input, array $expected): void
    {
        $program = self::asString($input['program'] ?? null);
        $instruction = self::asString($input['instruction'] ?? null);
        $key = $program . '/' . $instruction;

        if (($input['direction'] ?? null) === 'decode') {
            $bytes = self::hexToBin(self::asString($input['dataHex'] ?? null));
            if (!self::expectsError($expected)) {
                throw new VectorSkipped('decode-direction instruction vectors must expect an error');
            }
            $this->expectTypedError(static function () use ($key, $bytes): void {
                match ($key) {
                    'system/transferSol' => TransferSol::fromBytes($bytes),
                    'pump/buy' => Buy::fromBytes($bytes),
                    default => throw new VectorSkipped('no decoder dispatch for ' . $key),
                };
            });

            return;
        }

        $accounts = self::asStringMap($input['accounts'] ?? []);
        $args = self::asMap($input['args'] ?? []);
        $built = $this->buildInstruction($key, $accounts, $args);

        self::assertSame(self::asString($expected['programId'] ?? null), $built->programId->toBase58(), 'program id');
        self::assertSame(self::asString($expected['dataHex'] ?? null), \bin2hex($built->data), 'instruction data');

        if (!\array_key_exists('accounts', $expected)) {
            return;
        }
        $expectedMetas = self::asList($expected['accounts']);
        if (\count($expectedMetas) !== \count($built->accounts)) {
            throw new VectorFailure(\sprintf('expected %d account metas, got %d', \count($expectedMetas), \count($built->accounts)));
        }
        foreach ($expectedMetas as $index => $expectedMeta) {
            $meta = self::asMap($expectedMeta);
            $actual = $built->accounts[$index];
            $name = self::asString($meta['name'] ?? null);
            self::assertSame(self::asBool($meta['isSigner'] ?? null), $actual->isSigner, "isSigner of account [{$name}]");
            self::assertSame(self::asBool($meta['isWritable'] ?? null), $actual->isWritable, "isWritable of account [{$name}]");
            if (\array_key_exists('address', $meta)) {
                self::assertSame(self::asString($meta['address']), $actual->pubkey->toBase58(), "address of account [{$name}]");
            }
        }
    }

    /**
     * @param array<string, string> $accounts
     * @param array<string, mixed> $args
     */
    private function buildInstruction(
        string $key,
        array $accounts,
        array $args,
    ): \Generated\Dummy\Shared\Instruction|\Generated\Memo\Shared\Instruction|\Generated\Pump\Shared\Instruction|\Generated\System\Shared\Instruction {
        $systemAccount = static function (string $name) use ($accounts): Pubkey {
            if (!isset($accounts[$name])) {
                throw new VectorSkipped("builder requires account [{$name}] to be supplied explicitly");
            }

            return Pubkey::fromBase58($accounts[$name]);
        };
        $pumpAccount = static function (string $name) use ($accounts): PumpPubkey {
            if (!isset($accounts[$name])) {
                throw new VectorSkipped("builder requires account [{$name}] to be supplied explicitly");
            }

            return PumpPubkey::fromBase58($accounts[$name]);
        };
        // Caller-supplied accounts whose addresses are not pinned by the
        // vector (pump `create`): any placeholder pubkey will do.
        $pumpPlaceholder = static fn(string $name): PumpPubkey => isset($accounts[$name])
            ? PumpPubkey::fromBase58($accounts[$name])
            : PumpPubkey::fromBase58(\Generated\Pump\Program::ADDRESS);

        switch ($key) {
            case 'system/transferSol':
                return TransferSol::instruction(
                    $systemAccount('source'),
                    $systemAccount('destination'),
                    self::asIntLike($args['amount'] ?? null),
                );
            case 'system/createAccountWithSeed':
                return CreateAccountWithSeed::instruction(
                    $systemAccount('payer'),
                    $systemAccount('newAccount'),
                    $systemAccount('baseAccount'),
                    Pubkey::fromBase58(self::asString($args['base'] ?? null)),
                    self::asString($args['seed'] ?? null),
                    self::asIntLike($args['amount'] ?? null),
                    self::asIntLike($args['space'] ?? null),
                    Pubkey::fromBase58(self::asString($args['programAddress'] ?? null)),
                );
            case 'memo/addMemo':
                return AddMemo::instruction(self::asString($args['memo'] ?? null));
            case 'pump/buy':
                return Buy::instruction(
                    $pumpAccount('global'),
                    $pumpAccount('feeRecipient'),
                    $pumpAccount('mint'),
                    $pumpAccount('bondingCurve'),
                    $pumpAccount('associatedBondingCurve'),
                    $pumpAccount('associatedUser'),
                    $pumpAccount('user'),
                    $pumpAccount('systemProgram'),
                    $pumpAccount('tokenProgram'),
                    $pumpAccount('creatorVault'),
                    $pumpAccount('eventAuthority'),
                    $pumpAccount('program'),
                    $pumpAccount('globalVolumeAccumulator'),
                    $pumpAccount('userVolumeAccumulator'),
                    $pumpAccount('feeConfig'),
                    $pumpAccount('feeProgram'),
                    self::asIntLike($args['amount'] ?? null),
                    self::asIntLike($args['maxSolCost'] ?? null),
                    new OptionBool([self::asBool(self::asList($args['trackVolume'] ?? null)[0] ?? null)]),
                );
            case 'pump/create':
                return Create::instruction(
                    $pumpPlaceholder('mint'),
                    $pumpPlaceholder('mintAuthority'),
                    $pumpPlaceholder('bondingCurve'),
                    $pumpPlaceholder('associatedBondingCurve'),
                    $pumpPlaceholder('global'),
                    $pumpPlaceholder('mplTokenMetadata'),
                    $pumpPlaceholder('metadata'),
                    $pumpPlaceholder('user'),
                    $pumpPlaceholder('systemProgram'),
                    $pumpPlaceholder('tokenProgram'),
                    $pumpPlaceholder('associatedTokenProgram'),
                    $pumpPlaceholder('rent'),
                    $pumpPlaceholder('eventAuthority'),
                    $pumpPlaceholder('program'),
                    self::asString($args['name'] ?? null),
                    self::asString($args['symbol'] ?? null),
                    self::asString($args['uri'] ?? null),
                    PumpPubkey::fromBase58(self::asString($args['creator'] ?? null)),
                );
            case 'dummy/instruction3':
                return Instruction3::instruction();
            case 'dummy/instruction5':
                return \array_key_exists('myArgument', $args)
                    ? Instruction5::instruction(self::asIntLike($args['myArgument']))
                    : Instruction5::instruction();
            default:
                throw new VectorSkipped('no builder dispatch for ' . $key);
        }
    }

    // -----------------------------------------------------------------------
    // Mode: account
    // -----------------------------------------------------------------------

    /**
     * @param array<string, mixed> $input
     * @param array<string, mixed> $expected
     */
    private function runAccount(array $input, array $expected): void
    {
        $key = self::asString($input['program'] ?? null) . '/' . self::asString($input['account'] ?? null);

        if (($input['direction'] ?? null) === 'decode') {
            $bytes = self::hexToBin(self::asString($input['hex'] ?? null));
            if (!self::expectsError($expected)) {
                throw new VectorSkipped('decode-direction account vectors must expect an error');
            }
            $this->expectTypedError(static function () use ($key, $bytes): void {
                match ($key) {
                    'system/nonce' => Nonce::fromBytes($bytes),
                    'pump/bondingCurve' => BondingCurve::fromBytes($bytes),
                    'pump/feeConfig' => FeeConfig::fromBytes($bytes),
                    default => throw new VectorSkipped('no account dispatch for ' . $key),
                };
            });

            return;
        }

        $fields = self::asMap($input['fields'] ?? null);
        $expectedHex = self::asString($expected['hex'] ?? null);
        [$serialized, $decodedCanonical] = match ($key) {
            'system/nonce' => $this->roundTripNonce($fields, $expectedHex),
            'pump/bondingCurve' => $this->roundTripBondingCurve($fields, $expectedHex),
            'pump/feeConfig' => $this->roundTripFeeConfig($fields, $expectedHex),
            default => throw new VectorSkipped('no account dispatch for ' . $key),
        };

        self::assertSame($expectedHex, \bin2hex($serialized), 'serialized account');
        if (\array_key_exists('size', $expected)) {
            self::assertSame(self::asInt($expected['size']), \strlen($serialized), 'serialized size');
        }
        self::assertSame($this->canonicalAccountFields($key, $fields), $decodedCanonical, 'decoded account');
    }

    /**
     * @param array<string, mixed> $fields
     * @return array{string, array<string, mixed>}
     */
    private function roundTripNonce(array $fields, string $expectedHex): array
    {
        $account = new Nonce(
            NonceVersion::from(self::asInt($fields['version'] ?? null)),
            NonceState::from(self::asInt($fields['state'] ?? null)),
            Pubkey::fromBase58(self::asString($fields['authority'] ?? null)),
            Pubkey::fromBase58(self::asString($fields['blockhash'] ?? null)),
            self::asIntLike($fields['lamportsPerSignature'] ?? null),
        );
        $decoded = Nonce::fromBytes(self::hexToBin($expectedHex));

        return [$account->serialize(), [
            'authority' => $decoded->authority->toBase58(),
            'blockhash' => $decoded->blockhash->toBase58(),
            'lamportsPerSignature' => (string) $decoded->lamportsPerSignature,
            'state' => $decoded->state->value,
            'version' => $decoded->version->value,
        ]];
    }

    /**
     * @param array<string, mixed> $fields
     * @return array{string, array<string, mixed>}
     */
    private function roundTripBondingCurve(array $fields, string $expectedHex): array
    {
        $account = new BondingCurve(
            self::asIntLike($fields['virtualTokenReserves'] ?? null),
            self::asIntLike($fields['virtualSolReserves'] ?? null),
            self::asIntLike($fields['realTokenReserves'] ?? null),
            self::asIntLike($fields['realSolReserves'] ?? null),
            self::asIntLike($fields['tokenTotalSupply'] ?? null),
            self::asBool($fields['complete'] ?? null),
            PumpPubkey::fromBase58(self::asString($fields['creator'] ?? null)),
            self::asBool($fields['isMayhemMode'] ?? null),
        );
        $decoded = BondingCurve::fromBytes(self::hexToBin($expectedHex));

        return [$account->serialize(), [
            'complete' => $decoded->complete,
            'creator' => $decoded->creator->toBase58(),
            'isMayhemMode' => $decoded->isMayhemMode,
            'realSolReserves' => (string) $decoded->realSolReserves,
            'realTokenReserves' => (string) $decoded->realTokenReserves,
            'tokenTotalSupply' => (string) $decoded->tokenTotalSupply,
            'virtualSolReserves' => (string) $decoded->virtualSolReserves,
            'virtualTokenReserves' => (string) $decoded->virtualTokenReserves,
        ]];
    }

    /**
     * @param array<string, mixed> $fields
     * @return array{string, array<string, mixed>}
     */
    private function roundTripFeeConfig(array $fields, string $expectedHex): array
    {
        $fees = function (mixed $value): Fees {
            $map = self::asMap($value);

            return new Fees(
                self::asIntLike($map['lpFeeBps'] ?? null),
                self::asIntLike($map['protocolFeeBps'] ?? null),
                self::asIntLike($map['creatorFeeBps'] ?? null),
            );
        };
        $feeTiers = [];
        foreach (self::asList($fields['feeTiers'] ?? null) as $tier) {
            $tierMap = self::asMap($tier);
            $feeTiers[] = new FeeTier(
                self::asIntLike($tierMap['marketCapLamportsThreshold'] ?? null),
                $fees($tierMap['fees'] ?? null),
            );
        }
        $account = new FeeConfig(
            self::asInt($fields['bump'] ?? null),
            PumpPubkey::fromBase58(self::asString($fields['admin'] ?? null)),
            $fees($fields['flatFees'] ?? null),
            $feeTiers,
        );
        $decoded = FeeConfig::fromBytes(self::hexToBin($expectedHex));

        $feesCanonical = static fn(Fees $value): array => [
            'creatorFeeBps' => (string) $value->creatorFeeBps,
            'lpFeeBps' => (string) $value->lpFeeBps,
            'protocolFeeBps' => (string) $value->protocolFeeBps,
        ];

        return [$account->serialize(), [
            'admin' => $decoded->admin->toBase58(),
            'bump' => $decoded->bump,
            'feeTiers' => \array_map(static fn(FeeTier $tier): array => [
                'fees' => $feesCanonical($tier->fees),
                'marketCapLamportsThreshold' => (string) $tier->marketCapLamportsThreshold,
            ], $decoded->feeTiers),
            'flatFees' => $feesCanonical($decoded->flatFees),
        ]];
    }

    /**
     * Canonicalizes the portable `fields` of an account vector into the same
     * shape produced by the round-trip helpers above.
     *
     * @param array<string, mixed> $fields
     * @return array<string, mixed>
     */
    private function canonicalAccountFields(string $key, array $fields): array
    {
        if ($key === 'system/nonce') {
            return [
                'authority' => self::asString($fields['authority'] ?? null),
                'blockhash' => self::asString($fields['blockhash'] ?? null),
                'lamportsPerSignature' => (string) self::asIntLike($fields['lamportsPerSignature'] ?? null),
                'state' => self::asInt($fields['state'] ?? null),
                'version' => self::asInt($fields['version'] ?? null),
            ];
        }
        if ($key === 'pump/bondingCurve') {
            return [
                'complete' => self::asBool($fields['complete'] ?? null),
                'creator' => self::asString($fields['creator'] ?? null),
                'isMayhemMode' => self::asBool($fields['isMayhemMode'] ?? null),
                'realSolReserves' => (string) self::asIntLike($fields['realSolReserves'] ?? null),
                'realTokenReserves' => (string) self::asIntLike($fields['realTokenReserves'] ?? null),
                'tokenTotalSupply' => (string) self::asIntLike($fields['tokenTotalSupply'] ?? null),
                'virtualSolReserves' => (string) self::asIntLike($fields['virtualSolReserves'] ?? null),
                'virtualTokenReserves' => (string) self::asIntLike($fields['virtualTokenReserves'] ?? null),
            ];
        }
        // pump/feeConfig.
        $feesCanonical = static function (mixed $value): array {
            $map = self::asMap($value);

            return [
                'creatorFeeBps' => (string) self::asIntLike($map['creatorFeeBps'] ?? null),
                'lpFeeBps' => (string) self::asIntLike($map['lpFeeBps'] ?? null),
                'protocolFeeBps' => (string) self::asIntLike($map['protocolFeeBps'] ?? null),
            ];
        };
        $feeTiers = [];
        foreach (self::asList($fields['feeTiers'] ?? null) as $tier) {
            $tierMap = self::asMap($tier);
            $feeTiers[] = [
                'fees' => $feesCanonical($tierMap['fees'] ?? null),
                'marketCapLamportsThreshold' => (string) self::asIntLike($tierMap['marketCapLamportsThreshold'] ?? null),
            ];
        }

        return [
            'admin' => self::asString($fields['admin'] ?? null),
            'bump' => self::asInt($fields['bump'] ?? null),
            'feeTiers' => $feeTiers,
            'flatFees' => $feesCanonical($fields['flatFees'] ?? null),
        ];
    }

    // -----------------------------------------------------------------------
    // Assertion helpers
    // -----------------------------------------------------------------------

    /** @param array<string, mixed> $expected */
    private static function expectsError(array $expected): bool
    {
        return ($expected['error'] ?? false) === true;
    }

    /**
     * Runs `$operation` and requires it to raise one of the runtime's typed
     * errors: a `ClientException` (any fixture namespace), the
     * `\InvalidArgumentException`s thrown by validation code, or the
     * `\ValueError` raised by backed enums for unknown variant indexes.
     * Anything else — including no error at all — fails the vector.
     *
     * @param callable(): mixed $operation
     */
    private function expectTypedError(callable $operation): void
    {
        try {
            $operation();
        } catch (VectorSkipped $skipped) {
            throw $skipped;
        } catch (\Throwable $error) {
            if (self::isTypedError($error)) {
                return;
            }
            throw new VectorFailure('expected a typed error but got ' . $error::class . ': ' . $error->getMessage());
        }
        throw new VectorFailure('expected a typed error but none was raised');
    }

    private static function isTypedError(\Throwable $error): bool
    {
        return $error instanceof \Generated\Dummy\Shared\ClientException
            || $error instanceof \Generated\Memo\Shared\ClientException
            || $error instanceof \Generated\Pump\Shared\ClientException
            || $error instanceof \Generated\System\Shared\ClientException
            || $error instanceof \InvalidArgumentException
            || $error instanceof \ValueError;
    }

    private static function assertSame(mixed $expected, mixed $actual, string $what): void
    {
        if ($expected !== $actual) {
            throw new VectorFailure(\sprintf(
                '%s mismatch: expected %s, got %s',
                $what,
                \json_encode($expected, \JSON_THROW_ON_ERROR),
                \json_encode($actual, \JSON_THROW_ON_ERROR),
            ));
        }
    }

    // -----------------------------------------------------------------------
    // Typed accessors over decoded JSON (mixed) values
    // -----------------------------------------------------------------------

    /** @return array<string, mixed> */
    private static function asMap(mixed $value): array
    {
        if (!\is_array($value)) {
            throw new VectorFailure('expected a JSON object, got ' . \get_debug_type($value));
        }
        $map = [];
        foreach ($value as $key => $item) {
            $map[(string) $key] = $item;
        }

        return $map;
    }

    /** @return array<string, string> */
    private static function asStringMap(mixed $value): array
    {
        $map = [];
        foreach (self::asMap($value) as $key => $item) {
            $map[$key] = self::asString($item);
        }

        return $map;
    }

    /** @return list<mixed> */
    private static function asList(mixed $value): array
    {
        if (!\is_array($value) || !\array_is_list($value)) {
            throw new VectorFailure('expected a JSON array, got ' . \get_debug_type($value));
        }

        return $value;
    }

    private static function asString(mixed $value): string
    {
        if (!\is_string($value)) {
            throw new VectorFailure('expected a string, got ' . \get_debug_type($value));
        }

        return $value;
    }

    private static function asInt(mixed $value): int
    {
        if (!\is_int($value)) {
            throw new VectorFailure('expected an integer, got ' . \get_debug_type($value));
        }

        return $value;
    }

    /**
     * Accepts the corpus representation of 64/128-bit integers (decimal
     * strings) as well as plain JSON integers.
     *
     * @return int|numeric-string
     */
    private static function asIntLike(mixed $value): int|string
    {
        if (\is_int($value)) {
            return $value;
        }
        if (\is_string($value) && \is_numeric($value)) {
            return $value;
        }
        throw new VectorFailure('expected an integer or decimal string, got ' . \get_debug_type($value));
    }

    private static function asFloat(mixed $value): float
    {
        if (\is_int($value) || \is_float($value)) {
            return (float) $value;
        }
        throw new VectorFailure('expected a number, got ' . \get_debug_type($value));
    }

    private static function asBool(mixed $value): bool
    {
        if (!\is_bool($value)) {
            throw new VectorFailure('expected a boolean, got ' . \get_debug_type($value));
        }

        return $value;
    }

    private static function asArrayKey(mixed $value): int|string
    {
        if (\is_int($value) || \is_string($value)) {
            return $value;
        }
        throw new VectorFailure('expected an array key, got ' . \get_debug_type($value));
    }

    private static function hexToBin(string $hex): string
    {
        if ($hex === '') {
            return '';
        }
        $bytes = \hex2bin($hex);
        if ($bytes === false) {
            throw new VectorFailure('invalid hex string: ' . $hex);
        }

        return $bytes;
    }
}

$cliArgs = $_SERVER['argv'] ?? null;
if (\PHP_SAPI === 'cli' && \is_array($cliArgs) && isset($cliArgs[0]) && \is_string($cliArgs[0]) && \realpath($cliArgs[0]) === __FILE__) {
    exit(ConformanceRunner::main());
}
