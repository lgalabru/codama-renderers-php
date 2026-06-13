<?php

/**
 * Parses a clover coverage report produced by phpunit (see
 * `tools/phpunit.xml`) and enforces the line-coverage threshold on the
 * generated `Shared/` runtime, while also reporting coverage of the full
 * generated tree.
 *
 * Usage: php tools/check-coverage.php <clover.xml> [threshold]
 */

declare(strict_types=1);

namespace Codama\Tools;

const DEFAULT_THRESHOLD = 90.0;

/** @return array{covered: int, total: int} */
function statementsOf(\SimpleXMLElement $file): array
{
    $covered = 0;
    $total = 0;
    foreach ($file->line as $line) {
        if ((string) $line['type'] !== 'stmt') {
            continue;
        }
        $total++;
        if ((int) $line['count'] > 0) {
            $covered++;
        }
    }

    return ['covered' => $covered, 'total' => $total];
}

function percentage(int $covered, int $total): float
{
    return $total === 0 ? 100.0 : $covered / $total * 100.0;
}

function main(): int
{
    global $argv;
    $cloverPath = $argv[1] ?? null;
    if (!\is_string($cloverPath) || !\is_file($cloverPath)) {
        \fwrite(\STDERR, "Usage: php tools/check-coverage.php <clover.xml> [threshold]\n");

        return 1;
    }
    $threshold = isset($argv[2]) && \is_numeric($argv[2]) ? (float) $argv[2] : DEFAULT_THRESHOLD;

    $xml = \simplexml_load_file($cloverPath);
    if ($xml === false) {
        \fwrite(\STDERR, "Cannot parse clover report: {$cloverPath}\n");

        return 1;
    }

    $shared = ['covered' => 0, 'total' => 0];
    $tree = ['covered' => 0, 'total' => 0];
    /** @var list<array{string, float, int, int}> $rows */
    $rows = [];

    foreach ($xml->xpath('//file') ?: [] as $file) {
        $path = (string) $file['name'];
        if (!\str_contains($path, '/generated/')) {
            continue;
        }
        $stats = statementsOf($file);
        $tree['covered'] += $stats['covered'];
        $tree['total'] += $stats['total'];
        $isShared = \str_contains($path, '/generated/Shared/');
        if ($isShared) {
            $shared['covered'] += $stats['covered'];
            $shared['total'] += $stats['total'];
        }
        $position = \strpos($path, '/e2e/');
        $shortPath = $position === false ? $path : \substr($path, $position + 5);
        $rows[] = [$shortPath, percentage($stats['covered'], $stats['total']), $stats['covered'], $stats['total']];
    }

    if ($tree['total'] === 0) {
        \fwrite(\STDERR, "No generated files found in the clover report.\n");

        return 1;
    }

    \usort($rows, static fn(array $a, array $b): int => $a[0] <=> $b[0]);
    echo "Line coverage of the generated PHP tree:\n";
    foreach ($rows as [$path, $percent, $covered, $total]) {
        \printf("  %6.2f%% (%4d/%4d)  %s\n", $percent, $covered, $total, $path);
    }

    $sharedPercent = percentage($shared['covered'], $shared['total']);
    $treePercent = percentage($tree['covered'], $tree['total']);
    \printf("\nGenerated Shared/ runtime: %.2f%% lines covered (%d/%d)\n", $sharedPercent, $shared['covered'], $shared['total']);
    \printf("Full generated tree:       %.2f%% lines covered (%d/%d)\n", $treePercent, $tree['covered'], $tree['total']);

    if ($sharedPercent < $threshold) {
        \printf("FAIL: Shared/ runtime line coverage %.2f%% is below the %.2f%% threshold.\n", $sharedPercent, $threshold);

        return 1;
    }
    \printf("OK: Shared/ runtime line coverage meets the %.2f%% threshold.\n", $threshold);

    return 0;
}

exit(main());
