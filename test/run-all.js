/**
 * test/run-all.js
 * Master Test Runner for vConsole Remote 4-Tier Opaque-Box Test Suite
 * 
 * Executes all 4 Tiers and the 10-Step E2E Verification Pipeline:
 * - Tier 1: Feature Coverage (47 tests)
 * - Tier 2: Boundary & Corner Cases (31 tests)
 * - Tier 3: Cross-Feature Combinations (7 tests)
 * - Tier 4: Real-World Application Scenarios (5 tests)
 * - 10-Step E2E Verification Pipeline (10 assertions)
 * 
 * Usage:
 *   node test/run-all.js              # Run everything
 *   node test/run-all.js --tier=1     # Run Tier 1 only
 *   node test/run-all.js --tier=2     # Run Tier 2 only
 *   node test/run-all.js --tier=3     # Run Tier 3 only
 *   node test/run-all.js --tier=4     # Run Tier 4 only
 *   node test/run-all.js --verify     # Run 10-step E2E pipeline only
 */

const { runTier1 } = require('./tier1-feature.test');
const { runTier2 } = require('./tier2-boundary.test');
const { runTier3 } = require('./tier3-combination.test');
const { runTier4 } = require('./tier4-scenarios.test');
const { runE2EVerification } = require('./e2e-verify');

async function main() {
    const args = process.argv.slice(2);
    const tierArg = args.find((a) => a.startsWith('--tier='));
    const verifyOnly = args.includes('--verify');

    const specificTier = tierArg ? parseInt(tierArg.split('=')[1], 10) : null;

    console.log('================================================================');
    console.log('🏆 vCONSOLE REMOTE COMPREHENSIVE OPAQUE-BOX TEST RUNNER');
    console.log('================================================================');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Node.js Version: ${process.version}`);
    console.log(`Platform: ${process.platform} (${process.arch})\n`);

    const startTime = performance.now();
    let totalPassed = 0;
    let totalFailed = 0;
    const tierSummaries = [];

    async function executeTier(name, runner) {
        try {
            const res = await runner();
            if (typeof res === 'object' && res !== null) {
                totalPassed += res.passed || 0;
                totalFailed += res.failed || 0;
                tierSummaries.push({ name, status: 'PASS', passed: res.passed, failed: res.failed });
            } else {
                totalPassed += 1;
                tierSummaries.push({ name, status: 'PASS' });
            }
        } catch (err) {
            totalFailed += 1;
            tierSummaries.push({ name, status: 'FAIL', error: err.message });
        }
    }

    if (verifyOnly) {
        await executeTier('10-Step Automated E2E Pipeline', runE2EVerification);
    } else if (specificTier === 1) {
        await executeTier('Tier 1: Feature Coverage', runTier1);
    } else if (specificTier === 2) {
        await executeTier('Tier 2: Boundary & Corner Cases', runTier2);
    } else if (specificTier === 3) {
        await executeTier('Tier 3: Cross-Feature Combinations', runTier3);
    } else if (specificTier === 4) {
        await executeTier('Tier 4: Real-World Scenarios', runTier4);
    } else {
        // Run full suite
        await executeTier('Tier 1: Feature Coverage (47 tests)', runTier1);
        await executeTier('Tier 2: Boundary & Corner Cases (31 tests)', runTier2);
        await executeTier('Tier 3: Cross-Feature Combinations (7 tests)', runTier3);
        await executeTier('Tier 4: Real-World Scenarios (5 tests)', runTier4);
        await executeTier('10-Step Automated E2E Verification Pipeline', runE2EVerification);
    }

    const elapsedMs = performance.now() - startTime;

    console.log('\n================================================================');
    console.log('📊 FINAL TEST SUITE EXECUTION SUMMARY');
    console.log('================================================================');
    for (const s of tierSummaries) {
        const icon = s.status === 'PASS' ? '✅' : '❌';
        console.log(`  ${icon} ${s.name}: ${s.status} ${s.passed !== undefined ? `(${s.passed} passed, ${s.failed} failed)` : ''}`);
    }
    console.log('----------------------------------------------------------------');
    console.log(`Total Assertions Passed: ${totalPassed}`);
    console.log(`Total Assertions Failed: ${totalFailed}`);
    console.log(`Total Suite Runtime:     ${(elapsedMs / 1000).toFixed(2)}s`);
    console.log('================================================================\n');

    if (totalFailed > 0) {
        console.error(`❌ TEST SUITE FAILED with ${totalFailed} failure(s).`);
        process.exit(1);
    } else {
        console.log('🎉 100% OF TESTS PASSED SUCCESSFULLY.');
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
