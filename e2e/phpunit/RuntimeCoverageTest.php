<?php

/**
 * Exercises every branch of the generated `Shared/` runtime that the
 * conformance vectors and the smoke test do not reach, for each of the four
 * fixture clients (every generated client ships its own copy of the
 * runtime). The four copies only differ by namespace, so the sweep is
 * driven generically over the namespace prefix.
 *
 * The only intentionally unreachable lines are the `ensureGmp()` throws
 * (ext-gmp is required to run the suite at all) and the bump-exhausted
 * throw of `Pda::findProgramAddress()` (probability ~2^-256 per bump).
 */

declare(strict_types=1);

namespace Codama\E2E;

use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

final class RuntimeCoverageTest extends TestCase
{
    private const SYSTEM_ID = '11111111111111111111111111111111';
    private const PUMP_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

    public static function setUpBeforeClass(): void
    {
        foreach (['system', 'memo', 'pump-fun', 'dummy'] as $fixture) {
            if (!\is_file(\dirname(__DIR__) . '/' . $fixture . '/generated/autoload.php')) {
                self::markTestSkipped("Generated fixture clients missing; run ./e2e/generate.cjs {$fixture} first.");
            }
            require_once \dirname(__DIR__) . '/' . $fixture . '/generated/autoload.php';
        }
    }

    /** @return iterable<string, array{string}> */
    public static function namespaces(): iterable
    {
        yield 'system' => ['Generated\\System'];
        yield 'memo' => ['Generated\\Memo'];
        yield 'pump' => ['Generated\\Pump'];
        yield 'dummy' => ['Generated\\Dummy'];
    }

    // -----------------------------------------------------------------------
    // Borsh (write side)
    // -----------------------------------------------------------------------

    #[DataProvider('namespaces')]
    public function testBorshIntegerWriters(string $ns): void
    {
        self::assertSame("\x00", self::borsh($ns, 'u8', 0));
        self::assertSame("\xff", self::borsh($ns, 'u8', 255));
        self::assertThrows($ns, 'u8', 256);
        self::assertThrows($ns, 'u8', -1);

        self::assertSame("\x34\x12", self::borsh($ns, 'u16', 0x1234));
        self::assertThrows($ns, 'u16', 0x10000);

        self::assertSame("\xef\xbe\xad\xde", self::borsh($ns, 'u32', 0xDEADBEEF));
        self::assertThrows($ns, 'u32', -1);

        self::assertSame(\pack('P', 1), self::borsh($ns, 'u64', 1));
        self::assertSame(\str_repeat("\xff", 8), self::borsh($ns, 'u64', '18446744073709551615'));
        self::assertSame(\pack('P', 5), self::borsh($ns, 'u64', \gmp_init(5)));
        self::assertThrows($ns, 'u64', -1);
        self::assertThrows($ns, 'u64', '18446744073709551616');

        self::assertSame("\x2a" . \str_repeat("\x00", 15), self::borsh($ns, 'u128', 42));
        self::assertSame(\str_repeat("\xff", 16), self::borsh($ns, 'u128', '340282366920938463463374607431768211455'));
        self::assertThrows($ns, 'u128', -1);
        self::assertThrows($ns, 'u128', '340282366920938463463374607431768211456');

        self::assertSame("\x80", self::borsh($ns, 'i8', -128));
        self::assertSame("\x7f", self::borsh($ns, 'i8', 127));
        self::assertThrows($ns, 'i8', 128);

        self::assertSame("\xfe\xff", self::borsh($ns, 'i16', -2));
        self::assertThrows($ns, 'i16', 0x8000);

        self::assertSame("\xff\xff\xff\xff", self::borsh($ns, 'i32', -1));
        self::assertThrows($ns, 'i32', 0x80000000);

        self::assertSame(\str_repeat("\xff", 8), self::borsh($ns, 'i64', -1));
        self::assertSame("\x00\x00\x00\x00\x00\x00\x00\x80", self::borsh($ns, 'i64', '-9223372036854775808'));
        self::assertThrows($ns, 'i64', '9223372036854775808');

        self::assertSame(\str_repeat("\xff", 16), self::borsh($ns, 'i128', -1));
        self::assertSame(\pack('P', 7) . \str_repeat("\x00", 8), self::borsh($ns, 'i128', 7));
        self::assertSame(
            "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x80",
            self::borsh($ns, 'i128', '-170141183460469231731687303715884105728'),
        );
        self::assertSame(\str_repeat("\xff", 16), self::borsh($ns, 'i128', \gmp_init(-1)));
        self::assertThrows($ns, 'i128', '170141183460469231731687303715884105728');
    }

    #[DataProvider('namespaces')]
    public function testBorshScalarAndStringWriters(string $ns): void
    {
        self::assertSame("\x00\x00\xc0\x3f", self::borsh($ns, 'f32', 1.5));
        self::assertSame("\x00\x00\x00\x00\x00\x02\x90\xc0", self::borsh($ns, 'f64', -1024.5));
        self::assertSame("\x01", self::borsh($ns, 'bool', true));
        self::assertSame("\x00", self::borsh($ns, 'bool', false));

        self::assertSame("\x00", self::borsh($ns, 'shortU16', 0));
        self::assertSame("\x7f", self::borsh($ns, 'shortU16', 0x7F));
        self::assertSame("\x80\x01", self::borsh($ns, 'shortU16', 0x80));
        self::assertSame("\xff\xff\x03", self::borsh($ns, 'shortU16', 0xFFFF));
        self::assertThrows($ns, 'shortU16', -1);
        self::assertThrows($ns, 'shortU16', 0x10000);

        self::assertSame("\x05\x00\x00\x00hello", self::borsh($ns, 'str', 'hello'));
        self::assertSame("\x02\x00hi", self::borsh($ns, 'str', 'hi', 'u16'));
        self::assertSame("ab\x00\x00", self::borsh($ns, 'fixedStr', 'ab', 4));
        self::assertThrows($ns, 'fixedStr', 'abcde', 4);
        self::assertSame("\x02\x00\x00\x00\xaa\xbb", self::borsh($ns, 'bytes', "\xaa\xbb"));
        self::assertSame("\x02\xaa\xbb", self::borsh($ns, 'bytes', "\xaa\xbb", 'u8'));
        self::assertSame("\x01\x00", self::borsh($ns, 'fixedBytes', "\x01", 2));
    }

    #[DataProvider('namespaces')]
    public function testBorshCompositeWriters(string $ns): void
    {
        $writeU8 = self::borshWriter($ns, 'u8');
        $writeU16 = self::borshWriter($ns, 'u16');

        self::assertSame("\x00", self::borsh($ns, 'option', null, $writeU8));
        self::assertSame("\x01\x07", self::borsh($ns, 'option', 7, $writeU8));

        self::assertSame("\x02\x00\x00\x00\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16));
        self::assertSame("\x02\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16, 'u8'));
        self::assertSame("\x02\x00\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16, 'u16'));
        self::assertSame(
            "\x02\x00\x00\x00\x00\x00\x00\x00\x01\x00\x02\x00",
            self::borsh($ns, 'vec', [1, 2], $writeU16, 'u64'),
        );
        self::assertSame("\x02\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16, 'shortU16'));
        self::assertSame("\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16, 2));
        self::assertSame("\x01\x00\x02\x00", self::borsh($ns, 'vec', [1, 2], $writeU16, 'remainder'));
        self::assertThrows($ns, 'vec', [1, 2], $writeU16, 3);
        self::assertThrows($ns, 'vec', [1, 2], $writeU16, 'u128');

        self::assertSame("\x01\x00\x00\x00\x01\x0a", self::borsh($ns, 'map', [1 => 10], $writeU8, $writeU8));
        self::assertSame("\x01\x0a", self::borsh($ns, 'map', [1 => 10], $writeU8, $writeU8, 1));
        self::assertSame("\x01\x0a", self::borsh($ns, 'map', [1 => 10], $writeU8, $writeU8, 'remainder'));
        self::assertThrows($ns, 'map', [1 => 10], $writeU8, $writeU8, 2);
    }

    // -----------------------------------------------------------------------
    // BorshReader (read side)
    // -----------------------------------------------------------------------

    #[DataProvider('namespaces')]
    public function testBorshReaderScalars(string $ns): void
    {
        $reader = self::reader($ns, "\x01\x02\x03");
        self::assertSame(0, self::read($reader, 'offset'));
        self::assertSame(3, self::read($reader, 'remaining'));
        self::assertSame("\x01", self::read($reader, 'read', 1));
        self::assertSame("\x02\x03", self::read($reader, 'readRemainder'));
        self::assertSame(3, self::read($reader, 'offset'));
        self::assertReaderThrows($ns, "\x01", 'read', 2);
        self::assertReaderThrows($ns, '', 'read', -1);

        self::assertSame(255, self::read(self::reader($ns, "\xff"), 'readU8'));
        self::assertSame(0x1234, self::read(self::reader($ns, "\x34\x12"), 'readU16'));
        self::assertSame(0xDEADBEEF, self::read(self::reader($ns, "\xef\xbe\xad\xde"), 'readU32'));
        self::assertSame(1, self::read(self::reader($ns, \pack('P', 1)), 'readU64'));
        self::assertSame('18446744073709551615', self::read(self::reader($ns, \str_repeat("\xff", 8)), 'readU64'));
        self::assertSame(42, self::read(self::reader($ns, "\x2a" . \str_repeat("\x00", 15)), 'readU128'));
        self::assertSame(
            '340282366920938463463374607431768211455',
            self::read(self::reader($ns, \str_repeat("\xff", 16)), 'readU128'),
        );
        self::assertSame(-128, self::read(self::reader($ns, "\x80"), 'readI8'));
        self::assertSame(127, self::read(self::reader($ns, "\x7f"), 'readI8'));
        self::assertSame(-2, self::read(self::reader($ns, "\xfe\xff"), 'readI16'));
        self::assertSame(-1, self::read(self::reader($ns, "\xff\xff\xff\xff"), 'readI32'));
        self::assertSame(3, self::read(self::reader($ns, "\x03\x00\x00\x00"), 'readI32'));
        self::assertSame(-1, self::read(self::reader($ns, \str_repeat("\xff", 8)), 'readI64'));
        self::assertSame(-1, self::read(self::reader($ns, \str_repeat("\xff", 16)), 'readI128'));
        self::assertSame(7, self::read(self::reader($ns, \pack('P', 7) . \str_repeat("\x00", 8)), 'readI128'));
        self::assertSame(
            '170141183460469231731687303715884105727',
            self::read(self::reader($ns, \str_repeat("\xff", 15) . "\x7f"), 'readI128'),
        );
        self::assertSame(
            '-170141183460469231731687303715884105728',
            self::read(self::reader($ns, \str_repeat("\x00", 15) . "\x80"), 'readI128'),
        );
        self::assertSame(1.5, self::read(self::reader($ns, "\x00\x00\xc0\x3f"), 'readF32'));
        self::assertSame(1.5, self::read(self::reader($ns, "\x00\x00\x00\x00\x00\x00\xf8\x3f"), 'readF64'));
        self::assertTrue(self::asBool(self::read(self::reader($ns, "\x01"), 'readBool')));
        self::assertFalse(self::asBool(self::read(self::reader($ns, "\x00"), 'readBool')));
    }

    #[DataProvider('namespaces')]
    public function testBorshReaderComposites(string $ns): void
    {
        self::assertSame(0xFFFF, self::read(self::reader($ns, "\xff\xff\x03"), 'readShortU16'));
        self::assertReaderThrows($ns, "\x80\x80\x80\x01", 'readShortU16');
        self::assertReaderThrows($ns, "\x80", 'readShortU16');

        self::assertSame('hi', self::read(self::reader($ns, "\x02\x00\x00\x00hi"), 'readString'));
        self::assertSame('hi', self::read(self::reader($ns, "\x02hi"), 'readString', 'u8'));
        self::assertSame('abc', self::read(self::reader($ns, 'abcdef'), 'readFixedString', 3));
        self::assertSame("\xaa\xbb", self::read(self::reader($ns, "\x02\x00\xaa\xbb"), 'readBytes', 'u16'));
        self::assertSame("\xaa", self::read(self::reader($ns, \pack('P', 1) . "\xaa"), 'readBytes', 'u64'));
        self::assertReaderThrows($ns, "\x05\x00\x00\x00hi", 'readString');

        $reader = self::reader($ns, "\x01\x07");
        $readU8 = static fn(): mixed => self::read($reader, 'readU8');
        self::assertSame(7, self::read($reader, 'readOption', $readU8));
        self::assertNull(self::read(self::reader($ns, "\x00"), 'readOption', $readU8));

        $vecReader = self::reader($ns, "\x02\x00\x00\x00\x0a\x0b");
        $readVecU8 = static fn(): mixed => self::read($vecReader, 'readU8');
        self::assertSame([10, 11], self::read($vecReader, 'readVec', $readVecU8));

        $fixedReader = self::reader($ns, "\x0a\x0b");
        $readFixedU8 = static fn(): mixed => self::read($fixedReader, 'readU8');
        self::assertSame([10, 11], self::read($fixedReader, 'readVec', $readFixedU8, 2));

        $remainderReader = self::reader($ns, "\x0a\x0b\x0c");
        $readRemainderU8 = static fn(): mixed => self::read($remainderReader, 'readU8');
        self::assertSame([10, 11, 12], self::read($remainderReader, 'readVec', $readRemainderU8, 'remainder'));

        $shortReader = self::reader($ns, "\x01\x0a");
        $readShortU8 = static fn(): mixed => self::read($shortReader, 'readU8');
        self::assertSame([10], self::read($shortReader, 'readVec', $readShortU8, 'shortU16'));

        $u16Reader = self::reader($ns, "\x01\x00\x0a");
        $readU16U8 = static fn(): mixed => self::read($u16Reader, 'readU8');
        self::assertSame([10], self::read($u16Reader, 'readVec', $readU16U8, 'u16'));

        $badCountReader = self::reader($ns, "\x00");
        $readBadCount = static fn(): mixed => self::read($badCountReader, 'readU8');
        self::assertThrowsInvalidArgument(static fn(): mixed => self::read($badCountReader, 'readVec', $readBadCount, 'u128'));

        $mapReader = self::reader($ns, "\x01\x00\x00\x00\x01\x0a");
        $readMapU8 = static fn(): mixed => self::read($mapReader, 'readU8');
        self::assertSame([1 => 10], self::read($mapReader, 'readMap', $readMapU8, $readMapU8));

        $fixedMapReader = self::reader($ns, "\x01\x0a");
        $readFixedMapU8 = static fn(): mixed => self::read($fixedMapReader, 'readU8');
        self::assertSame([1 => 10], self::read($fixedMapReader, 'readMap', $readFixedMapU8, $readFixedMapU8, 1));

        $remainderMapReader = self::reader($ns, "\x01\x0a\x02\x14");
        $readRemainderMapU8 = static fn(): mixed => self::read($remainderMapReader, 'readU8');
        self::assertSame(
            [1 => 10, 2 => 20],
            self::read($remainderMapReader, 'readMap', $readRemainderMapU8, $readRemainderMapU8, 'remainder'),
        );
    }

    // -----------------------------------------------------------------------
    // Pubkey
    // -----------------------------------------------------------------------

    #[DataProvider('namespaces')]
    public function testPubkey(string $ns): void
    {
        $class = $ns . '\\Shared\\Pubkey';
        $systemId = self::call($class, 'fromBase58', self::SYSTEM_ID);
        self::assertIsObject($systemId);
        self::assertSame(\str_repeat("\x00", 32), self::get($systemId, 'bytes'));
        self::assertSame(self::SYSTEM_ID, self::read($systemId, 'toBase58'));
        self::assertSame(self::SYSTEM_ID, self::read($systemId, '__toString'));

        $pumpId = self::call($class, 'fromBase58', self::PUMP_ID);
        self::assertTrue(self::asBool(self::read($systemId, 'equals', $systemId)));
        self::assertFalse(self::asBool(self::read($systemId, 'equals', $pumpId)));

        self::assertThrowsInvalidArgument(static fn(): object => self::make($class, 'too short'));
        self::assertThrowsInvalidArgument(static fn(): mixed => self::call($class, 'fromBase58', 'l0l'));
        self::assertThrowsInvalidArgument(static fn(): mixed => self::call($class, 'fromBase58', '5T'));

        self::assertSame('', self::call($class, 'base58Encode', ''));
        self::assertSame('11', self::call($class, 'base58Encode', "\x00\x00"));
        self::assertSame('StV1DL6CwTryKyV', self::call($class, 'base58Encode', 'hello world'));
        self::assertSame('', self::call($class, 'base58Decode', ''));
        self::assertSame("\x00", self::call($class, 'base58Decode', '1'));
        self::assertSame('hello world', self::call($class, 'base58Decode', 'StV1DL6CwTryKyV'));
        self::assertSame("\x00\x00\x01\x02\x03", self::call($class, 'base58Decode', '11Ldp', 5));
        self::assertThrowsInvalidArgument(static fn(): mixed => self::call($class, 'base58Decode', '11Ldp', 4));
    }

    // -----------------------------------------------------------------------
    // Pda
    // -----------------------------------------------------------------------

    #[DataProvider('namespaces')]
    public function testPda(string $ns): void
    {
        $class = $ns . '\\Shared\\Pda';
        $pubkeyClass = $ns . '\\Shared\\Pubkey';
        $systemId = self::make($pubkeyClass, \str_repeat("\x00", 32));

        // findProgramAddress exercises the bump retry loop (bump 251).
        $found = self::call($class, 'findProgramAddress', ['vault', 'user9'], $systemId);
        self::assertIsArray($found);
        self::assertIsObject($found[0]);
        self::assertSame('6XTsA8455CLY6YFgrbxVh9QgGb8424aKUYX4ZmyvfuHA', self::read($found[0], 'toBase58'));
        self::assertSame(251, $found[1]);

        $created = self::call($class, 'createProgramAddress', ['vault', 'user9', \chr(251)], $systemId);
        self::assertIsObject($created);
        self::assertSame('6XTsA8455CLY6YFgrbxVh9QgGb8424aKUYX4ZmyvfuHA', self::read($created, 'toBase58'));

        // Bump 255 lies on the curve for these seeds.
        self::assertThrowsClientException(
            $ns,
            static fn(): mixed => self::call($class, 'createProgramAddress', ['vault', 'user9', \chr(255)], $systemId),
        );
        // Seed validation.
        self::assertThrowsInvalidArgument(
            static fn(): mixed => self::call($class, 'createProgramAddress', [\str_repeat('a', 33)], $systemId),
        );
        self::assertThrowsInvalidArgument(
            static fn(): mixed => self::call($class, 'createProgramAddress', \array_fill(0, 17, 'a'), $systemId),
        );

        // isOnCurve corner cases.
        self::assertFalse(self::asBool(self::call($class, 'isOnCurve', 'short')));
        self::assertTrue(self::asBool(self::call($class, 'isOnCurve', \str_repeat("\x00", 32))));
        // y = 1 (the identity point): x² = 0, decodable iff the sign bit is 0.
        self::assertTrue(self::asBool(self::call($class, 'isOnCurve', "\x01" . \str_repeat("\x00", 31))));
        self::assertFalse(self::asBool(self::call($class, 'isOnCurve', "\x01" . \str_repeat("\x00", 30) . "\x80")));
        // y >= p is a non-canonical encoding.
        self::assertFalse(self::asBool(self::call($class, 'isOnCurve', \str_repeat("\xff", 31) . "\x7f")));
    }

    // -----------------------------------------------------------------------
    // AccountMeta, Instruction and the exception hierarchy
    // -----------------------------------------------------------------------

    #[DataProvider('namespaces')]
    public function testInstructionValueObjects(string $ns): void
    {
        $pubkey = self::make($ns . '\\Shared\\Pubkey', \str_repeat("\x00", 32));
        $meta = self::make($ns . '\\Shared\\AccountMeta', $pubkey, true, false);
        self::assertSame($pubkey, self::get($meta, 'pubkey'));
        self::assertTrue(self::asBool(self::get($meta, 'isSigner')));
        self::assertFalse(self::asBool(self::get($meta, 'isWritable')));

        $instruction = self::make($ns . '\\Shared\\Instruction', $pubkey, [$meta], "\x01\x02");
        self::assertSame($pubkey, self::get($instruction, 'programId'));
        self::assertSame([$meta], self::get($instruction, 'accounts'));
        self::assertSame("\x01\x02", self::get($instruction, 'data'));
    }

    #[DataProvider('namespaces')]
    public function testExceptionHierarchy(string $ns): void
    {
        $client = self::make($ns . '\\Shared\\ClientException', 'boom');
        self::assertInstanceOf(\RuntimeException::class, $client);

        $serialization = self::make($ns . '\\Shared\\SerializationException', 'bad bytes');
        self::assertTrue(\is_a($serialization, $ns . '\\Shared\\ClientException'));

        $pda = self::make($ns . '\\Shared\\PdaException', 'on curve');
        self::assertTrue(\is_a($pda, $ns . '\\Shared\\ClientException'));

        $program = self::make($ns . '\\Shared\\ProgramException', 7, 'program failed');
        self::assertTrue(\is_a($program, $ns . '\\Shared\\ClientException'));
        self::assertSame(7, self::get($program, 'errorCode'));
        self::assertInstanceOf(\Throwable::class, $program);
        self::assertSame(7, $program->getCode());
        self::assertSame('program failed', $program->getMessage());
    }

    // -----------------------------------------------------------------------
    // Program ids and error catalogs (concrete per-client classes)
    // -----------------------------------------------------------------------

    public function testProgramClasses(): void
    {
        self::assertSame(self::SYSTEM_ID, \Generated\System\Program::id()->toBase58());
        self::assertSame('system', \Generated\System\Program::NAME);
        self::assertSame(self::PUMP_ID, \Generated\Pump\Program::id()->toBase58());
        self::assertSame('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', \Generated\Memo\Program::id()->toBase58());
        self::assertSame('Dummy11111111111111111111111111111111111111', \Generated\Dummy\Program::id()->toBase58());
    }

    public function testErrorCatalogs(): void
    {
        self::assertSame(
            'an account with the same address already exists',
            \Generated\System\Errors::message(\Generated\System\Errors::ACCOUNT_ALREADY_IN_USE),
        );
        self::assertNull(\Generated\System\Errors::message(123456789));
        self::assertSame(123456789, \Generated\System\Errors::exception(123456789)->errorCode);

        self::assertSame('The given account is not authorized to execute this instruction.', \Generated\Pump\Errors::message(6000));
        self::assertNull(\Generated\Pump\Errors::message(-1));
        $exception = \Generated\Pump\Errors::exception(6000);
        self::assertSame(6000, $exception->errorCode);
        self::assertStringContainsString('not authorized', $exception->getMessage());
    }

    // -----------------------------------------------------------------------
    // Generic, phpstan-friendly invocation helpers. The runtime classes only
    // exist per generated namespace, so calls are dispatched dynamically.
    // -----------------------------------------------------------------------

    /** Calls a static method of the `Borsh` writer class of the namespace. */
    private static function borsh(string $ns, string $method, mixed ...$args): mixed
    {
        return self::call($ns . '\\Shared\\Borsh', $method, ...$args);
    }

    /** Returns a writer callable for one-argument `Borsh` methods (vec/map items). */
    private static function borshWriter(string $ns, string $method): callable
    {
        return static fn(mixed $value): mixed => self::borsh($ns, $method, $value);
    }

    /** Creates a `BorshReader` of the namespace over the given bytes. */
    private static function reader(string $ns, string $data): object
    {
        return self::make($ns . '\\Shared\\BorshReader', $data);
    }

    private static function call(string $class, string $method, mixed ...$args): mixed
    {
        $callable = [$class, $method];
        \assert(\is_callable($callable));

        return $callable(...$args);
    }

    private static function read(object $instance, string $method, mixed ...$args): mixed
    {
        $callable = [$instance, $method];
        \assert(\is_callable($callable));

        return $callable(...$args);
    }

    private static function make(string $class, mixed ...$args): object
    {
        \assert(\class_exists($class));

        return new $class(...$args);
    }

    private static function get(object $instance, string $property): mixed
    {
        $values = \get_object_vars($instance);
        self::assertArrayHasKey($property, $values);

        return $values[$property];
    }

    private static function asBool(mixed $value): bool
    {
        self::assertIsBool($value);

        return $value;
    }

    /** Asserts that a `Borsh` writer call rejects its input with an `\InvalidArgumentException`. */
    private static function assertThrows(string $ns, string $method, mixed ...$args): void
    {
        self::assertThrowsInvalidArgument(static fn(): mixed => self::borsh($ns, $method, ...$args));
    }

    /** Asserts that reading the given bytes raises the namespace's `SerializationException`. */
    private static function assertReaderThrows(string $ns, string $data, string $method, mixed ...$args): void
    {
        $reader = self::reader($ns, $data);
        try {
            self::read($reader, $method, ...$args);
        } catch (\Throwable $error) {
            self::assertTrue(
                \is_a($error, $ns . '\\Shared\\SerializationException'),
                'Expected a SerializationException, got ' . $error::class . ': ' . $error->getMessage(),
            );

            return;
        }
        self::fail("Expected {$method} to throw a SerializationException.");
    }

    /** @param callable(): mixed $operation */
    private static function assertThrowsInvalidArgument(callable $operation): void
    {
        try {
            $operation();
        } catch (\InvalidArgumentException $error) {
            self::assertNotSame('', $error->getMessage());

            return;
        }
        self::fail('Expected an InvalidArgumentException to be thrown.');
    }

    /** @param callable(): mixed $operation */
    private static function assertThrowsClientException(string $ns, callable $operation): void
    {
        try {
            $operation();
        } catch (\Throwable $error) {
            self::assertTrue(
                \is_a($error, $ns . '\\Shared\\ClientException'),
                'Expected a ClientException, got ' . $error::class . ': ' . $error->getMessage(),
            );

            return;
        }
        self::fail('Expected a ClientException to be thrown.');
    }
}
