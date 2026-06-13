#!/usr/bin/env bash
set -euxo pipefail

function test_project() {
    ./e2e/generate.cjs $1
    # Syntax check every generated PHP file.
    find e2e/$1/generated -name '*.php' -print0 | while IFS= read -r -d '' file; do
        php -l "$file" >/dev/null
    done
}

test_project dummy
test_project system
test_project memo
test_project pump-fun

# Run the smoke test against the generated clients.
php -d zend.assertions=1 -d assert.exception=1 e2e/smoke.php

# Run the shared cross-language conformance vectors against the generated
# clients. The runner warns and exits 0 when ../conformance is missing.
php -d zend.assertions=1 -d assert.exception=1 e2e/conformance_runner.php

# Style and static analysis of the generated code (PER-CS / PSR-12 via
# php-cs-fixer, phpstan at level max). Skipped gracefully when the tools
# are not installed; install them with: composer install -d tools
if [ -x tools/vendor/bin/php-cs-fixer ]; then
    tools/vendor/bin/php-cs-fixer check --config=.php-cs-fixer.dist.php --diff
else
    echo "php-cs-fixer not installed (composer install -d tools); skipping style check."
fi
if [ -x tools/vendor/bin/phpstan ]; then
    tools/vendor/bin/phpstan analyse --configuration=phpstan.neon --no-progress
else
    echo "phpstan not installed (composer install -d tools); skipping static analysis."
fi

# Coverage of the generated PHP runtime (phpunit + pcov). Runs the
# conformance vectors, the smoke test and the dedicated runtime coverage
# test in-process, then enforces >= 90% line coverage on the generated
# Shared/ runtime. Skipped gracefully when phpunit is not installed.
if [ -x tools/vendor/bin/phpunit ]; then
    php -d zend.assertions=1 -d assert.exception=1 -d pcov.enabled=1 -d pcov.directory=e2e \
        tools/vendor/bin/phpunit --configuration tools/phpunit.xml \
        --coverage-clover e2e/phpunit/coverage/clover.xml
    php tools/check-coverage.php e2e/phpunit/coverage/clover.xml
else
    echo "phpunit not installed (composer install -d tools); skipping PHP coverage."
fi
