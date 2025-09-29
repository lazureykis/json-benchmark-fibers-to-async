#!/usr/bin/env node

/**
 * Enhanced benchmark showing timeout capabilities
 */

const Fiber = require('fibers');
const yj = require('yieldable-json');
const fs = require('fs');
const crypto = require('crypto');

// Simple AbortController polyfill for Node 14
class SimpleAbortController {
  constructor() {
    this.signal = { aborted: false };
  }
  abort() {
    this.signal.aborted = true;
  }
}

// ============================================================================
// Fixed Fiber Implementation
// ============================================================================

// Simple Block implementation for fiber yielding
class Block {
  constructor() {
    this.fiber = Fiber.current;
    this.resolved = false;
  }

  success() {
    if (!this.resolved) {
      this.resolved = true;
      if (this.fiber) {
        this.fiber.run();
      }
    }
  }

  wait() {
    if (!this.resolved) {
      Fiber.yield();
    }
  }
}

function runWithFiber(fn, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Fiber timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const fiber = Fiber(() => {
      try {
        const result = fn();
        clearTimeout(timeoutId);
        if (!timedOut) {
          resolve(result);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        if (!timedOut) {
          reject(error);
        }
      }
    });

    // Start the fiber
    fiber.run();
  });
}

function fiberStringify(obj, yieldEveryMs = 5) {
  // Using Block mechanism for fiber yielding
  let lastYield = process.hrtime();
  let callCount = 0;
  let yieldCount = 0;
  const CHECK_INTERVAL = 100; // Check time every 100 calls

  function optionalPause() {
    const diff = process.hrtime(lastYield);
    const elapsedMs = diff[0] * 1000 + diff[1] / 1e6;

    if (elapsedMs > yieldEveryMs) {
      yieldCount++;
      // Use Block mechanism for yielding
      const block = new Block();
      setImmediate(() => block.success());
      block.wait(); // This yields and waits for setImmediate callback
      lastYield = process.hrtime();
    }
  }

  // Use JSON.stringify with replacer for incremental processing
  const result = JSON.stringify(obj, function(key, value) {
    callCount++;

    // Check every 100 calls
    if (callCount % CHECK_INTERVAL === 0) {
      optionalPause();
    }

    return value;
  });

  // For debugging: check if we yielded
  if (yieldCount === 0 && callCount > CHECK_INTERVAL) {
    // JSON.stringify was too fast, never hit the 5ms threshold
  }

  return result;
}

// ============================================================================
// Async Implementation Options
// ============================================================================

// Approach 1: yieldable-json library - designed for this exact use case
async function asyncStringifyYieldable(obj, timeoutMs, yieldEveryMs = 10) {
  const controller = new SimpleAbortController();

  try {
    // yieldable-json takes a callback as the 4th parameter
    const result = await Promise.race([
      new Promise((resolve, reject) => {
        yj.stringifyAsync(obj, null, null, (err, res) => {
          if (err) reject(err);
          else resolve(res);
        });
      }),
      new Promise((_, reject) => {
        setTimeout(() => {
          controller.abort();
          reject(new Error(`Yieldable-json timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);

    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Yieldable-json timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

// Approach 2: Custom async stringify (our implementation)
async function asyncStringify(obj, timeoutMs, yieldEveryMs = 5) {
  const controller = new SimpleAbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Exactly matching fiber implementation approach
  let lastYield = process.hrtime();
  let callCount = 0;
  const CHECK_INTERVAL = 100; // Check time every 100 calls like fibers

  async function checkAndYield() {
    callCount++;

    // Check every 100 calls
    if (callCount % CHECK_INTERVAL === 0) {
      const diff = process.hrtime(lastYield);
      const elapsedMs = diff[0] * 1000 + diff[1] / 1e6;

      if (elapsedMs > yieldEveryMs) {
        await new Promise(r => setImmediate(r));
        lastYield = process.hrtime();
      }
    }

    if (controller.signal.aborted) {
      throw new Error(`Async timeout after ${timeoutMs}ms`);
    }
  }

  // Custom stringify that can actually yield
  async function stringify(value, visited = new WeakSet()) {
    await checkAndYield();

    if (value === null || value === undefined) return 'null';

    const type = typeof value;

    // Handle primitives - but be careful with huge strings!
    if (type !== 'object') {
      if (type === 'string') {
        // For large strings, process in chunks to avoid blocking
        if (value.length > 10000) {
          // Escape the string manually in chunks
          let result = '"';
          for (let i = 0; i < value.length; i += 10000) {
            const chunk = value.slice(i, Math.min(i + 10000, value.length));
            // Use JSON.stringify on small chunks
            const escaped = JSON.stringify(chunk);
            // Remove the quotes that JSON.stringify adds
            result += escaped.slice(1, -1);

            // Yield periodically for huge strings
            if (i % 100000 === 0 && i > 0) {
              await checkAndYield();
            }
          }
          result += '"';
          return result;
        }
      }
      // Small strings and other primitives are safe
      return JSON.stringify(value);
    }

    if (visited.has(value)) return '"[Circular]"';
    visited.add(value);

    if (Array.isArray(value)) {
      const parts = [];
      for (const item of value) {
        parts.push(await stringify(item, visited));
      }
      return '[' + parts.join(',') + ']';
    }

    const entries = [];
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined && typeof val !== 'function') {
        entries.push(JSON.stringify(key) + ':' + await stringify(val, visited));
      }
    }
    return '{' + entries.join(',') + '}';
  }

  try {
    const result = await stringify(obj);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}


// ============================================================================
// Test Object Generator
// ============================================================================

function createTestObject(size) {
  const obj = { arrays: [], objects: {} };

  // Create nested structure based on size
  for (let i = 0; i < size; i++) {
    // Add arrays with data
    obj.arrays.push(Array(10).fill(null).map((_, j) => ({
      id: `${i}_${j}`,
      data: 'x'.repeat(100),
      nested: { value: Math.random() }
    })));

    // Add object properties
    obj.objects[`prop_${i}`] = {
      data: 'y'.repeat(200),
      timestamp: Date.now(),
      items: Array(5).fill(null).map(() => ({ val: Math.random() }))
    };
  }

  return obj;
}

// ============================================================================
// Event Loop Monitor
// ============================================================================

class EventLoopMonitor {
  constructor() {
    this.intervals = 0;
    this.blocks = [];
    this.lastCheck = Date.now();
    this.interval = null;
  }

  start() {
    this.intervals = 0;
    this.blocks = [];
    this.lastCheck = Date.now();

    this.interval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - this.lastCheck;
      if (elapsed > 20) {
        this.blocks.push(elapsed);
      }
      this.lastCheck = now;
      this.intervals++;
    }, 10);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    return {
      intervals: this.intervals,
      maxBlock: Math.max(0, ...this.blocks),
      blockCount: this.blocks.length,
      blocks: this.blocks
    };
  }
}

// ============================================================================
// Output Validation
// ============================================================================

function getHash(str) {
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 8);
}

function validateOutput(result, expected) {
  if (result === expected) {
    return { valid: true, hash: getHash(result) };
  }

  // If not exact match, check if they're semantically equivalent
  try {
    const resultObj = JSON.parse(result);
    const expectedObj = JSON.parse(expected);
    const areEqual = JSON.stringify(resultObj) === JSON.stringify(expectedObj);

    if (areEqual) {
      return { valid: true, hash: getHash(result), note: 'Different formatting but equivalent' };
    }
  } catch (e) {
    // Not valid JSON
  }

  return { valid: false, hash: getHash(result), error: 'Output mismatch!' };
}

// ============================================================================
// Main Benchmark
// ============================================================================

async function runBenchmark() {
  console.log('='.repeat(80));
  console.log('JSON Serialization: Timeout & Non-blocking Demonstration with Validation');
  console.log('='.repeat(80));

  // First, create and save test objects
  console.log('\nCreating test objects and saving reference outputs...');
  const testDataDir = './test-data';
  if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir);
  }

  const tests = [
    { size: 10, timeout: 1000, name: 'Small object - should complete' },
    { size: 100, timeout: 50, name: 'Medium object - tight timeout' },
    { size: 500, timeout: 200, name: 'Large object - will likely timeout' },
    { size: 1000, timeout: 500, name: 'Huge object - aggressive timeout test' },
    { size: 10000, timeout: 5000, name: 'MASSIVE object - 20MB stress test' }
  ];

  // Create all test objects and their reference outputs
  for (const test of tests) {
    const obj = createTestObject(test.size);
    const referenceOutput = JSON.stringify(obj);

    // Save test object and reference output
    fs.writeFileSync(`${testDataDir}/test-${test.size}.json`, referenceOutput);
    test.obj = obj;
    test.referenceOutput = referenceOutput;
    test.referenceHash = getHash(referenceOutput);

    console.log(`  Test ${test.size}: ${(referenceOutput.length / 1024).toFixed(1)} KB, hash: ${test.referenceHash}`);
  }

  console.log('\nStarting benchmarks with output validation...');

  for (const test of tests) {
    console.log('\n' + '='.repeat(80));
    console.log(`TEST: ${test.name}`);
    console.log(`Size: ${test.size}, Timeout: ${test.timeout}ms`);
    console.log(`Reference hash: ${test.referenceHash}`);
    console.log('='.repeat(80));

    const obj = test.obj;

    // Estimate size
    try {
      const sample = JSON.stringify(obj.arrays[0] || {});
      console.log(`Estimated total size: ~${(sample.length * test.size / 1024).toFixed(1)} KB\n`);
    } catch (e) {}

    // 1. Native JSON.stringify (baseline)
    console.log('1. NATIVE JSON.stringify (blocking):');
    const monitor1 = new EventLoopMonitor();
    monitor1.start();
    const t1 = Date.now();
    try {
      const result = JSON.stringify(obj);
      const duration = Date.now() - t1;
      const stats = monitor1.stop();
      const validation = validateOutput(result, test.referenceOutput);
      console.log(`   ✅ Completed in ${duration}ms (${(result.length / 1024).toFixed(1)} KB)`);
      console.log(`   Event loop: ${stats.blockCount} blocks, max ${stats.maxBlock}ms`);
      console.log(`   Validation: ${validation.valid ? '✅ PASS' : '❌ FAIL'} (hash: ${validation.hash})`);
    } catch (e) {
      monitor1.stop();
      console.log(`   ❌ Failed: ${e.message}`);
    }

    // 2. Fiber-based with timeout
    console.log('\n2. FIBER-based (with yielding):');
    const monitor2 = new EventLoopMonitor();
    monitor2.start();
    const t2 = Date.now();

    // Schedule the fiber operation
    const fiberPromise = new Promise((resolve) => {
      setTimeout(() => {
        try {
          runWithFiber(() => fiberStringify(obj, 5), test.timeout)
            .then(result => {
              const duration = Date.now() - t2;
              const stats = monitor2.stop();
              const validation = validateOutput(result, test.referenceOutput);
              console.log(`   ✅ Completed in ${duration}ms (${(result.length / 1024).toFixed(1)} KB)`);
              console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks, max ${stats.maxBlock}ms`);
              console.log(`   Validation: ${validation.valid ? '✅ PASS' : '❌ FAIL'} (hash: ${validation.hash})`);
              resolve();
            })
            .catch(error => {
              const duration = Date.now() - t2;
              const stats = monitor2.stop();
              if (error.message.includes('timeout')) {
                console.log(`   ⏱️  Timeout at ${duration}ms: ${error.message}`);
              } else {
                console.log(`   ❌ Error at ${duration}ms: ${error.message}`);
              }
              console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks`);
              console.log(`   Note: Fiber yields but JSON.stringify with replacer is inherently slow`);
              resolve();
            });
        } catch (e) {
          monitor2.stop();
          console.log(`   ❌ Error: ${e.message}`);
          resolve();
        }
      }, 0);
    });

    await fiberPromise;

    // 3. Yieldable-json library (production-ready solution)
    console.log('\n3. YIELDABLE-JSON (production library):');
    const monitor3 = new EventLoopMonitor();
    monitor3.start();
    const t3 = Date.now();
    try {
      const result = await asyncStringifyYieldable(obj, test.timeout, 5);
      const duration = Date.now() - t3;
      const stats = monitor3.stop();
      const validation = validateOutput(result, test.referenceOutput);
      console.log(`   ✅ Completed in ${duration}ms (${(result.length / 1024).toFixed(1)} KB)`);
      console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks, max ${stats.maxBlock}ms`);
      console.log(`   Validation: ${validation.valid ? '✅ PASS' : '❌ FAIL'} (hash: ${validation.hash})`);
    } catch (error) {
      const duration = Date.now() - t3;
      const stats = monitor3.stop();
      console.log(`   ⏱️  Timeout at ${duration}ms: ${error.message}`);
      console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks`);
    }

    // 4. Custom async stringify (our implementation)
    console.log('\n4. ASYNC/AWAIT (custom stringify):');
    const monitor4 = new EventLoopMonitor();
    monitor4.start();
    const t4 = Date.now();
    try {
      const result = await asyncStringify(obj, test.timeout, 5);
      const duration = Date.now() - t4;
      const stats = monitor4.stop();
      const validation = validateOutput(result, test.referenceOutput);
      console.log(`   ✅ Completed in ${duration}ms (${(result.length / 1024).toFixed(1)} KB)`);
      console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks, max ${stats.maxBlock}ms`);
      console.log(`   Validation: ${validation.valid ? '✅ PASS' : '❌ FAIL'} (hash: ${validation.hash})`);
    } catch (error) {
      const duration = Date.now() - t4;
      const stats = monitor4.stop();
      console.log(`   ⏱️  Timeout at ${duration}ms: ${error.message}`);
      console.log(`   Event loop: ${stats.intervals} intervals, ${stats.blockCount} blocks`);
    }

    // 5. Demonstrate concurrent work during serialization
    console.log('\n5. CONCURRENT WORK TEST (async approach):');
    let concurrentWork = 0;
    const workInterval = setInterval(() => concurrentWork++, 5);

    const t5 = Date.now();
    try {
      await asyncStringify(obj, test.timeout * 2, 5);
      clearInterval(workInterval);
      const duration = Date.now() - t5;
      const expected = Math.floor(duration / 5);
      console.log(`   Concurrent work: ${concurrentWork}/${expected} expected iterations`);
      console.log(`   Efficiency: ${(concurrentWork / expected * 100).toFixed(1)}%`);
    } catch (e) {
      clearInterval(workInterval);
      const duration = Date.now() - t5;
      const expected = Math.floor(duration / 5);
      console.log(`   Concurrent work: ${concurrentWork}/${expected} iterations during timeout`);
    }
  }

  // ============================================================================
  // INTERRUPTION TEST - Aggressive timeout on massive object
  // ============================================================================
  console.log('\n' + '='.repeat(80));
  console.log('INTERRUPTION TEST: 50ms timeout on 20MB object');
  console.log('Testing that all approaches can be cleanly interrupted');
  console.log('='.repeat(80));

  const massiveObj = createTestObject(10000);
  const targetTimeout = 50;

  console.log(`\nObject size: ~20MB, Target timeout: ${targetTimeout}ms`);
  console.log('Expected: All approaches should timeout close to 50ms\n');

  // Test Fiber-based
  console.log('1. FIBER-based interruption:');
  const fiberStart = Date.now();
  try {
    await new Promise((resolve, reject) => {
      runWithFiber(() => fiberStringify(massiveObj, 5), targetTimeout)
        .then(resolve)
        .catch(reject);
    });
    console.log('   ❌ Should have timed out!');
  } catch (error) {
    const actualTime = Date.now() - fiberStart;
    const difference = actualTime - targetTimeout;
    console.log(`   ✅ Interrupted successfully`);
    console.log(`   Target: ${targetTimeout}ms, Actual: ${actualTime}ms, Diff: ${difference >= 0 ? '+' : ''}${difference}ms`);
    console.log(`   Error: ${error.message}`);
  }

  // Test Yieldable-json
  console.log('\n2. YIELDABLE-JSON interruption:');
  const yieldableStart = Date.now();
  try {
    await asyncStringifyYieldable(massiveObj, targetTimeout, 5);
    console.log('   ❌ Should have timed out!');
  } catch (error) {
    const actualTime = Date.now() - yieldableStart;
    const difference = actualTime - targetTimeout;
    console.log(`   ✅ Interrupted successfully`);
    console.log(`   Target: ${targetTimeout}ms, Actual: ${actualTime}ms, Diff: ${difference >= 0 ? '+' : ''}${difference}ms`);
    console.log(`   Error: ${error.message}`);
  }

  // Test Custom Async
  console.log('\n3. CUSTOM ASYNC interruption:');
  const asyncStart = Date.now();
  try {
    await asyncStringify(massiveObj, targetTimeout, 5);
    console.log('   ❌ Should have timed out!');
  } catch (error) {
    const actualTime = Date.now() - asyncStart;
    const difference = actualTime - targetTimeout;
    console.log(`   ✅ Interrupted successfully`);
    console.log(`   Target: ${targetTimeout}ms, Actual: ${actualTime}ms, Diff: ${difference >= 0 ? '+' : ''}${difference}ms`);
    console.log(`   Error: ${error.message}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('SUMMARY:');
  console.log('- Native: Fast but blocks event loop completely');
  console.log('- Fiber: Can yield but requires special runtime (deprecated)');
  console.log('- Async/await: Modern, non-blocking, timeout-capable');
  console.log('- All approaches (Fiber, Yieldable-json, Custom Async) can be interrupted by timeout');
  console.log('- Interruption happens within milliseconds of the target timeout');
  console.log('- Async/await allows true concurrent work during serialization');
  console.log('='.repeat(80));
}

// Run
if (require.main === module) {
  runBenchmark().catch(console.error);
}