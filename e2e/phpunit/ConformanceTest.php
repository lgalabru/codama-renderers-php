<?php

/**
 * Runs the conformance vectors and the e2e smoke test in-process so that
 * phpunit/pcov can measure how much of the generated PHP runtime they
 * exercise. See `tools/phpunit.xml` and `e2e/test.sh`.
 */

declare(strict_types=1);

namespace Codama\E2E;

use Codama\Conformance\ConformanceRunner;
use PHPUnit\Framework\TestCase;

final class ConformanceTest extends TestCase
{
    public static function setUpBeforeClass(): void
    {
        foreach (['system', 'memo', 'pump-fun', 'dummy'] as $fixture) {
            if (!\is_file(\dirname(__DIR__) . '/' . $fixture . '/generated/autoload.php')) {
                self::markTestSkipped("Generated fixture clients missing; run ./e2e/generate.cjs {$fixture} first.");
            }
        }
    }

    public function testConformanceVectorsPass(): void
    {
        require_once \dirname(__DIR__) . '/conformance_runner.php';
        $vectorsDir = \dirname(__DIR__, 3) . '/conformance/vectors';
        if (!\is_dir($vectorsDir)) {
            self::markTestSkipped('Conformance corpus not found at ' . $vectorsDir);
        }
        $runner = new ConformanceRunner($vectorsDir);
        \ob_start();
        $exitCode = $runner->run();
        $output = (string) \ob_get_clean();
        self::assertSame(0, $exitCode, $output);
        self::assertSame(0, $runner->failureCount(), $output);
        self::assertStringContainsString('All conformance vectors passed.', $output);
    }

    public function testSmokeTestPasses(): void
    {
        if (\ini_get('zend.assertions') !== '1') {
            self::markTestSkipped('Run phpunit with: php -d zend.assertions=1 -d assert.exception=1');
        }
        $this->expectOutputString("All smoke tests passed.\n");
        require \dirname(__DIR__) . '/smoke.php';
    }
}
