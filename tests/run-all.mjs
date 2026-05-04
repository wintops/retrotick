#!/usr/bin/env node
// Run all headless tests in parallel and report a summary.
//
// Two categories:
//   - TERM: tests that terminate naturally on their own. PASS = exit code 0
//           within the timeout. Anything else is FAIL.
//   - SIM:  tests that run a DOS/Win program forever (no natural exit).
//           We give them a shorter timeout; PASS = still running when the
//           timer fires and output contains no crash marker. If they exit
//           early with a non-zero code, or emit FATAL/WILD EIP/halt
//           markers, it's a FAIL.
//
// Usage:
//   node tests/run-all.mjs                  # run everything
//   node tests/run-all.mjs --only vcpi      # run tests whose name matches
//   node tests/run-all.mjs --verbose        # dump each test's output on fail
//   node tests/run-all.mjs --concurrency 8  # override default parallelism

import { spawn } from 'child_process';
import { readdirSync } from 'fs';
import { performance } from 'perf_hooks';
import { cpus } from 'os';

const TERM_TIMEOUT_MS = 60_000; // deterministic tests
const SIM_TIMEOUT_MS  = 10_000; // infinite-loop sims
// Default concurrency: half the CPU count (each test loads the full emulator
// and is CPU-bound). Running 20+ npx processes at once thrashes Windows hard.
const DEFAULT_CONCURRENCY = Math.max(2, Math.floor(cpus().length / 2));

// Tests that never terminate on their own — killing them after SIM_TIMEOUT_MS
// is the expected outcome. Everything else is treated as TERM.
const SIM_TESTS = new Set([
  'test-emul5.mjs',
  'test-secondreality.mjs',
  'test-sr-crash.mjs',
  'test-sr-mcb.mjs',
  'test-pop.mjs',
  'test-ckblabl.mjs',
  'test-doom.mjs',
]);

// Substrings that indicate a crash inside a SIM test's output.
const CRASH_MARKERS = [
  '[CPU-HALT]',
  '[WILD EIP]',
  'FATAL',
  'Illegal instruction',
  'ReferenceError',
  'TypeError',
  'is not a function',
  'Cannot read prop',
];

// Regex that, when seen in stdout, means the test passed — even if the
// process itself never exits (some tests forget process.exit(0)). We
// short-circuit the timer as soon as one of these is observed.
const SUCCESS_PATTERNS = [
  /\[TEST\] SUCCESS/,
  /\[TEST\] Results:\s*\d+\s+passed,\s*0\s+failed/,
  /\[VCPI TESTS\]\s*\d+\s+passed,\s*0\s+failed/,
  /\[TEST\] All\b.*\bpassed\b/,
];

// Regex that means the test's own assertions failed (printed its own failure
// message). A terminating test may still exit 0 in that case, so we check
// output too.
const FAIL_PATTERNS = [
  /\[TEST\] FAIL/i,
  /\[TEST\] Results:\s*\d+\s+passed,\s*[1-9]\d*\s+failed/,
  /\bAssertionError\b/,
];

// ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const onlyIdx = args.indexOf('--only');
const onlyFilter = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const concIdx = args.indexOf('--concurrency');
const concurrency = concIdx >= 0 ? parseInt(args[concIdx + 1], 10) : DEFAULT_CONCURRENCY;

const TESTS_DIR = new URL('./', import.meta.url);
const allFiles = readdirSync(TESTS_DIR)
  .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter(f => !onlyFilter || f.includes(onlyFilter))
  .sort();

if (allFiles.length === 0) {
  console.error('No test files found.');
  process.exit(2);
}

console.log(`Running ${allFiles.length} tests (concurrency=${concurrency})…\n`);

function killTree(pid) {
  // On Windows, child.kill() only terminates the cmd.exe shell wrapper,
  // leaving npx/node/tsx running. Use taskkill to nuke the whole tree.
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/t', '/f']); } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  }
}

function runOne(file) {
  const isSim = SIM_TESTS.has(file);
  const timeoutMs = isSim ? SIM_TIMEOUT_MS : TERM_TIMEOUT_MS;
  const started = performance.now();

  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', `tests/${file}`], {
      cwd: process.cwd(),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    let killedByTimeout = false;
    let killedBySuccess = false;

    const checkSuccess = () => {
      if (killedBySuccess || killedByTimeout) return;
      if (SUCCESS_PATTERNS.some(re => re.test(out))) {
        killedBySuccess = true;
        clearTimeout(timer);
        killTree(child.pid);
      }
    };

    child.stdout.on('data', (d) => { out += d.toString(); checkSuccess(); });
    child.stderr.on('data', (d) => { err += d.toString(); });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      killTree(child.pid);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Math.round(performance.now() - started);
      const combined = out + err;
      const hasCrash = CRASH_MARKERS.some(m => combined.includes(m));
      const hasFail = FAIL_PATTERNS.some(re => re.test(out));
      const hasSuccess = SUCCESS_PATTERNS.some(re => re.test(out));

      let status;
      let note = '';

      if (hasFail) {
        status = 'FAIL';
        note = 'test reported failure in output';
      } else if (killedBySuccess) {
        status = 'PASS';
        note = 'success marker matched';
      } else if (isSim) {
        // Sim tests: timeout is the expected outcome; check for crash markers.
        if (!killedByTimeout && code !== 0) {
          status = 'FAIL';
          note = `exited early with code ${code}`;
        } else if (hasCrash) {
          status = 'FAIL';
          const firstMarker = CRASH_MARKERS.find(m => combined.includes(m));
          note = `crash marker "${firstMarker}"`;
        } else if (killedByTimeout) {
          status = 'PASS';
          note = 'ran until timeout (sim)';
        } else {
          status = 'PASS';
          note = 'exited cleanly';
        }
      } else {
        // Deterministic tests: need exit 0 within timeout.
        if (killedByTimeout) {
          status = 'FAIL';
          note = `timed out after ${timeoutMs / 1000}s`;
        } else if (code !== 0) {
          status = 'FAIL';
          note = `exit code ${code}`;
        } else if (hasCrash && !hasSuccess) {
          status = 'FAIL';
          const firstMarker = CRASH_MARKERS.find(m => combined.includes(m));
          note = `crash marker "${firstMarker}"`;
        } else {
          status = 'PASS';
        }
      }

      resolve({ file, status, note, ms, out, err, isSim });
    });
  });
}

// Bounded-concurrency pool: process the queue in parallel, at most `concurrency`
// workers at a time. Each worker pulls the next file from the queue and runs it.
const results = [];
const queue = [...allFiles];
let inFlight = 0;
let nextIndex = 0;

async function worker() {
  while (queue.length > 0) {
    const file = queue.shift();
    const idx = nextIndex++;
    inFlight++;
    process.stdout.write(`\x1b[90m[${idx + 1}/${allFiles.length}] ${file}…\x1b[0m\n`);
    const r = await runOne(file);
    results.push(r);
    inFlight--;
    const icon = r.status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    process.stdout.write(`${icon} ${file} (${r.ms}ms) ${r.note}\n`);
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

// ── Report ────────────────────────────────────────────────────────────
results.sort((a, b) => a.file.localeCompare(b.file));
const pad = (s, n) => s.padEnd(n);
const passed = results.filter(r => r.status === 'PASS');
const failed = results.filter(r => r.status === 'FAIL');

console.log(`\n${pad('Test', 40)} ${pad('Status', 6)} ${pad('Time', 8)} Notes`);
console.log('─'.repeat(90));
for (const r of results) {
  const icon = r.status === 'PASS' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  const type = r.isSim ? '[sim]' : '     ';
  console.log(`${pad(r.file, 40)} ${icon} ${pad(r.status, 4)} ${pad(r.ms + 'ms', 8)} ${type} ${r.note}`);
}
console.log('─'.repeat(90));
console.log(`${passed.length} passed, ${failed.length} failed`);

if (verbose && failed.length > 0) {
  console.log('\n── Failed test output ─────────────────────────────────────────────');
  for (const r of failed) {
    console.log(`\n▼ ${r.file}`);
    if (r.out) console.log('── stdout ──\n' + r.out.slice(-2000));
    if (r.err) console.log('── stderr ──\n' + r.err.slice(-2000));
  }
}

process.exit(failed.length > 0 ? 1 : 0);
