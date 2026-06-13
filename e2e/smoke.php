<?php

/**
 * Smoke test for the generated PHP clients.
 * Run with: php -d zend.assertions=1 -d assert.exception=1 e2e/smoke.php
 */

declare(strict_types=1);

if (\ini_get('zend.assertions') !== '1') {
    fwrite(STDERR, "Run with: php -d zend.assertions=1 e2e/smoke.php\n");
    exit(1);
}

require __DIR__ . '/system/generated/autoload.php';
require __DIR__ . '/pump-fun/generated/autoload.php';
require __DIR__ . '/dummy/generated/autoload.php';

use Generated\Dummy\Instructions\Instruction5;
use Generated\Pump\Accounts\BondingCurve;
use Generated\Pump\Instructions\Buy;
use Generated\Pump\Types\OptionBool;
use Generated\System\Accounts\Nonce;
use Generated\System\Errors;
use Generated\System\Instructions\TransferSol;
use Generated\System\Program;
use Generated\System\Shared\Borsh;
use Generated\System\Shared\BorshReader;
use Generated\System\Shared\ClientException;
use Generated\System\Shared\Pda;
use Generated\System\Shared\PdaException;
use Generated\System\Shared\Pubkey;
use Generated\System\Shared\SerializationException;
use Generated\System\Types\NonceState;
use Generated\System\Types\NonceVersion;

// ---------------------------------------------------------------------------
// Base58 round trips.
// ---------------------------------------------------------------------------
$systemId = '11111111111111111111111111111111';
assert(Pubkey::fromBase58($systemId)->bytes === \str_repeat("\x00", 32));
assert(Pubkey::fromBase58($systemId)->toBase58() === $systemId);
$pumpId = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
assert(Pubkey::fromBase58($pumpId)->toBase58() === $pumpId);
assert((string) Program::id() === $systemId);
assert(Program::id()->toBase58() === Program::ADDRESS);

// ---------------------------------------------------------------------------
// TransferSol instruction: data is exactly [2,0,0,0, <u64 LE amount>].
// ---------------------------------------------------------------------------
$source = Pubkey::fromBase58('GpHzfnYHnJNqRmL4mNQu7BFFcBcwTakTQEDrCdcVm5Zt');
$destination = Pubkey::fromBase58('7g2eDDDvbWoUjjSMSGA4WdQhSBNRRGTRwY4MQer2hUYy');
$amount = 1_000_000;
$ix = TransferSol::instruction($source, $destination, $amount);
assert($ix->data === "\x02\x00\x00\x00" . \pack('P', $amount));
assert($ix->data === TransferSol::DISCRIMINATOR . \pack('P', $amount));
assert($ix->programId->toBase58() === $systemId);
assert(\count($ix->accounts) === 2);
assert($ix->accounts[0]->pubkey->equals($source));
assert($ix->accounts[0]->isSigner === true);
assert($ix->accounts[0]->isWritable === true);
assert($ix->accounts[1]->pubkey->equals($destination));
assert($ix->accounts[1]->isSigner === false);
assert($ix->accounts[1]->isWritable === true);

// Instruction data round trip.
$decoded = TransferSol::fromBytes($ix->data);
assert($decoded->amount === $amount);

// ---------------------------------------------------------------------------
// Nonce account round trip (u32-sized scalar enums + pubkeys + u64).
// ---------------------------------------------------------------------------
$nonce = new Nonce(
    version: NonceVersion::Current,
    state: NonceState::Initialized,
    authority: $source,
    blockhash: $destination,
    lamportsPerSignature: 5000,
);
$bytes = $nonce->serialize();
assert(\strlen($bytes) === Nonce::SIZE);
assert(\substr($bytes, 0, 8) === "\x01\x00\x00\x00\x01\x00\x00\x00");
$decodedNonce = Nonce::fromBytes($bytes);
assert($decodedNonce->version === NonceVersion::Current);
assert($decodedNonce->state === NonceState::Initialized);
assert($decodedNonce->authority->equals($source));
assert($decodedNonce->blockhash->equals($destination));
assert($decodedNonce->lamportsPerSignature === 5000);

// ---------------------------------------------------------------------------
// Errors lookup.
// ---------------------------------------------------------------------------
assert(Errors::message(Errors::ACCOUNT_ALREADY_IN_USE) === 'an account with the same address already exists');
assert(Errors::message(123456789) === null);

// Exception hierarchy: ProgramException carries the code and message and is
// a ClientException, the base type of every client-specific failure.
$programError = Errors::exception(Errors::ACCOUNT_ALREADY_IN_USE);
assert($programError->errorCode === Errors::ACCOUNT_ALREADY_IN_USE);
assert($programError->getCode() === Errors::ACCOUNT_ALREADY_IN_USE);
assert($programError->getMessage() === 'an account with the same address already exists');
assert(\str_contains(Errors::exception(123456789)->getMessage(), 'Unknown System program error code'));
$caughtCode = null;
try {
    throw Errors::exception(Errors::RESULT_WITH_NEGATIVE_LAMPORTS);
} catch (ClientException $exception) {
    $caughtCode = $exception->getCode();
}
assert($caughtCode === Errors::RESULT_WITH_NEGATIVE_LAMPORTS);

// Truncated data raises a SerializationException (a ClientException too).
$threwSerialization = false;
try {
    (new BorshReader("\x01"))->readU32();
} catch (ClientException $exception) {
    $threwSerialization = $exception instanceof SerializationException;
}
assert($threwSerialization === true);

// ---------------------------------------------------------------------------
// Borsh primitives, including u64 above 2^63 and 128-bit integers.
// ---------------------------------------------------------------------------
assert(Borsh::u64('18446744073709551615') === \str_repeat("\xff", 8));
assert((new BorshReader(\str_repeat("\xff", 8)))->readU64() === '18446744073709551615');
assert((new BorshReader(\pack('P', 123)))->readU64() === 123);
assert(Borsh::u64(0x7FFFFFFFFFFFFFFF) === "\xff\xff\xff\xff\xff\xff\xff\x7f");
assert((new BorshReader("\xff\xff\xff\xff\xff\xff\xff\x7f"))->readU64() === PHP_INT_MAX);
assert((new BorshReader(Borsh::u64('9223372036854775808')))->readU64() === '9223372036854775808');

assert(Borsh::i64(-1) === \str_repeat("\xff", 8));
assert((new BorshReader(\str_repeat("\xff", 8)))->readI64() === -1);
assert((new BorshReader(Borsh::i64(-5000)))->readI64() === -5000);

assert(Borsh::u128('340282366920938463463374607431768211455') === \str_repeat("\xff", 16));
assert(
    (new BorshReader(\str_repeat("\xff", 16)))->readU128() === '340282366920938463463374607431768211455',
);
assert((new BorshReader(Borsh::u128(42)))->readU128() === 42);
assert((new BorshReader(Borsh::i128(-1)))->readI128() === -1);
assert(
    (new BorshReader(Borsh::i128('-170141183460469231731687303715884105728')))->readI128()
        === '-170141183460469231731687303715884105728',
);

assert(Borsh::str('hello') === "\x05\x00\x00\x00hello");
assert((new BorshReader("\x05\x00\x00\x00hello"))->readString() === 'hello');
/** @var int|null $noValue Exercises the `null` branch of Borsh::option(). */
$noValue = null;
assert(Borsh::option($noValue, fn(int $v) => Borsh::u8($v)) === "\x00");
assert(Borsh::option(7, fn($v) => Borsh::u8($v)) === "\x01\x07");
assert((new BorshReader("\x00"))->readOption(fn() => 1) === null);
$vec = Borsh::vec([1, 2, 3], fn($v) => Borsh::u16($v));
assert($vec === "\x03\x00\x00\x00\x01\x00\x02\x00\x03\x00");
$reader = new BorshReader($vec);
assert($reader->readVec(fn() => $reader->readU16()) === [1, 2, 3]);
assert((new BorshReader(Borsh::f64(1.5)))->readF64() === 1.5);
assert(Borsh::shortU16(0x7F) === "\x7f");
assert(Borsh::shortU16(0x80) === "\x80\x01");
assert((new BorshReader("\x80\x01"))->readShortU16() === 0x80);
$map = Borsh::map(['a' => 1, 'b' => 2], fn($k) => Borsh::str($k), fn($v) => Borsh::u8($v));
$mapReader = new BorshReader($map);
assert($mapReader->readMap(fn() => $mapReader->readString(), fn() => $mapReader->readU8()) === ['a' => 1, 'b' => 2]);

// ---------------------------------------------------------------------------
// PDA derivation against vectors generated with @solana/web3.js.
// ---------------------------------------------------------------------------
[$address, $bump] = Pda::findProgramAddress(
    ['vault', Pubkey::fromBase58($pumpId)->bytes],
    Pubkey::fromBase58($systemId),
);
assert($address->toBase58() === '9QupkCyPmS9N3GGtkrsfuVqQwnRCCemUY6mCMKahkQVh');
assert($bump === 255);

[$address, $bump] = Pda::findProgramAddress(['metadata', 'metaplex'], Pubkey::fromBase58($pumpId));
assert($address->toBase58() === 'CPkf1tvGMVF5aGMnBQ27HE13xji6PCy3j6fAFysfNCN4');
assert($bump === 255);

[$address, $bump] = Pda::findProgramAddress(
    [\pack('P', 42), 'global'],
    Pubkey::fromBase58('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
);
assert($address->toBase58() === 'EH2Du28uF223ZMiJFLvH3v5Ur7JbE3vmyz4qC8ktVERG');
assert($bump === 254);

// Bump 251: exercises the on-curve rejection loop several times.
[$address, $bump] = Pda::findProgramAddress(['vault', 'user9'], Pubkey::fromBase58($systemId));
assert($address->toBase58() === '6XTsA8455CLY6YFgrbxVh9QgGb8424aKUYX4ZmyvfuHA');
assert($bump === 251);

// createProgramAddress with the found bump must yield the same address.
$direct = Pda::createProgramAddress(['vault', 'user9', \chr(251)], Pubkey::fromBase58($systemId));
assert($direct->equals($address));

// Bump 255 lies on the curve for these seeds and raises a PdaException.
$threwPda = false;
try {
    Pda::createProgramAddress(['vault', 'user9', \chr(255)], Pubkey::fromBase58($systemId));
} catch (PdaException) {
    $threwPda = true;
}
assert($threwPda === true);

// ---------------------------------------------------------------------------
// Pump-fun client: anchor 8-byte discriminators, tuple alias, account codec.
// Each generated client ships its own runtime, so use the pump Pubkey class.
// ---------------------------------------------------------------------------
$pumpSource = \Generated\Pump\Shared\Pubkey::fromBase58($source->toBase58());
$pumpDestination = \Generated\Pump\Shared\Pubkey::fromBase58($destination->toBase58());
$buy = Buy::instruction(
    global: $pumpSource,
    feeRecipient: $pumpSource,
    mint: $pumpSource,
    bondingCurve: $pumpSource,
    associatedBondingCurve: $pumpSource,
    associatedUser: $pumpSource,
    user: $pumpSource,
    systemProgram: $pumpSource,
    tokenProgram: $pumpSource,
    creatorVault: $pumpSource,
    eventAuthority: $pumpSource,
    program: $pumpSource,
    globalVolumeAccumulator: $pumpSource,
    userVolumeAccumulator: $pumpSource,
    feeConfig: $pumpSource,
    feeProgram: $pumpSource,
    amount: '18446744073709551615',
    maxSolCost: 1,
    trackVolume: new OptionBool([true]),
);
assert(\substr($buy->data, 0, 8) === \hex2bin('66063d1201daebea'));
assert(\substr($buy->data, 0, 8) === Buy::DISCRIMINATOR);
assert(\substr($buy->data, 8, 8) === \str_repeat("\xff", 8));
assert(\substr($buy->data, 16, 8) === \pack('P', 1));
assert(\substr($buy->data, 24) === "\x01");
$decodedBuy = Buy::fromBytes($buy->data);
assert($decodedBuy->amount === '18446744073709551615');
assert($decodedBuy->maxSolCost === 1);
assert($decodedBuy->trackVolume->value === [true]);

$curve = new BondingCurve(
    virtualTokenReserves: '10000000000000000000',
    virtualSolReserves: 2,
    realTokenReserves: 3,
    realSolReserves: 4,
    tokenTotalSupply: 5,
    complete: false,
    creator: $pumpDestination,
    isMayhemMode: true,
);
$curveBytes = $curve->serialize();
assert(\strlen($curveBytes) === BondingCurve::SIZE);
assert(\substr($curveBytes, 0, 8) === BondingCurve::DISCRIMINATOR);
$decodedCurve = BondingCurve::fromBytes($curveBytes);
assert($decodedCurve->virtualTokenReserves === '10000000000000000000');
assert($decodedCurve->virtualSolReserves === 2);
assert($decodedCurve->complete === false);
assert($decodedCurve->creator->equals($pumpDestination));
assert($decodedCurve->isMayhemMode === true);

// ---------------------------------------------------------------------------
// Dummy client: optional argument with default value (42).
// ---------------------------------------------------------------------------
$ix5 = Instruction5::instruction();
assert($ix5->data === \pack('P', 42));
$ix5 = Instruction5::instruction(43);
assert($ix5->data === \pack('P', 43));

echo "All smoke tests passed.\n";
