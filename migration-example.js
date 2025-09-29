#!/usr/bin/env node

/**
 * Side-by-side comparison showing how to migrate from fibers to async/await
 * This file demonstrates the exact patterns needed for migration
 */

// ============================================================================
// ORIGINAL: Fiber-based Implementation (legacy approach)
// ============================================================================

function createFiberImplementation() {
  // Only load fibers if available (Node 14 with fibers installed)
  let Fiber;
  try {
    Fiber = require('fibers');
  } catch (e) {
    return null; // Fibers not available
  }

  return {
    /**
     * Incremental JSON stringify using fibers
     * Based on traditional fiber-based incremental serialization
     */
    incremental_json_stringify(obj, replacer, space) {
      let result;
      const fiber = Fiber(() => {
        result = this.stringifyWithFiber(obj, replacer, space);
      });
      fiber.run();
      return result;
    },

    stringifyWithFiber(obj, replacer, space) {
      const startTime = Date.now();
      let lastYield = startTime;
      let operations = 0;

      // Equivalent to traditional optional_pause
      function optional_pause(msg) {
        operations++;
        const now = Date.now();

        // Check if we should yield (every 5ms or 100 operations)
        if (now - lastYield > 5 || operations > 100) {
          // Traditional: setImmediate(() => Fiber.current.run())
          setImmediate(() => {
            if (Fiber.current) {
              try {
                Fiber.current.run();
              } catch (e) {
                // Fiber already completed
              }
            }
          });

          Fiber.yield(); // Pause execution
          lastYield = Date.now();
          operations = 0;
        }
      }

      // Recursive stringify with periodic pausing
      function stringify(value, visited = new WeakSet()) {
        optional_pause('stringify start');

        if (value === null || value === undefined) return 'null';

        const type = typeof value;
        if (type !== 'object') return JSON.stringify(value);

        if (visited.has(value)) return '"[Circular]"';
        visited.add(value);

        if (Array.isArray(value)) {
          const parts = [];
          for (let i = 0; i < value.length; i++) {
            parts.push(stringify(value[i], visited));
            if (i % 10 === 0) optional_pause('array item');
          }
          return '[' + parts.join(',') + ']';
        }

        const entries = [];
        let count = 0;
        for (const [key, val] of Object.entries(value)) {
          if (val !== undefined && typeof val !== 'function') {
            entries.push(JSON.stringify(key) + ':' + stringify(val, visited));
            if (++count % 10 === 0) optional_pause('object key');
          }
        }
        return '{' + entries.join(',') + '}';
      }

      return stringify(obj);
    }
  };
}

// ============================================================================
// MIGRATED: Async/Await Implementation
// ============================================================================

const AsyncImplementation = {
  /**
   * Incremental JSON stringify using async/await
   * Direct replacement for fiber-based version
   */
  async incremental_json_stringify(obj, replacer, space) {
    return await this.stringifyAsync(obj, replacer, space);
  },

  async stringifyAsync(obj, replacer, space) {
    const startTime = Date.now();
    let lastYield = startTime;
    let operations = 0;
    let aborted = false;

    // Replacement for optional_pause - now async
    async function checkAndYield(msg) {
      operations++;
      const now = Date.now();

      // Same logic as fiber version: yield every 5ms or 100 operations
      if (now - lastYield > 5 || operations > 100) {
        // Instead of Fiber.yield(), use async yielding
        await new Promise(resolve => setImmediate(resolve));
        lastYield = Date.now();
        operations = 0;
      }

      // Could check for abort/timeout here if needed
      if (aborted) {
        throw new Error('Operation aborted');
      }
    }

    // Recursive stringify with async pausing
    async function stringify(value, visited = new WeakSet()) {
      await checkAndYield('stringify start');

      if (value === null || value === undefined) return 'null';

      const type = typeof value;
      if (type !== 'object') return JSON.stringify(value);

      if (visited.has(value)) return '"[Circular]"';
      visited.add(value);

      if (Array.isArray(value)) {
        const parts = [];
        for (let i = 0; i < value.length; i++) {
          parts.push(await stringify(value[i], visited));
          if (i % 10 === 0) await checkAndYield('array item');
        }
        return '[' + parts.join(',') + ']';
      }

      const entries = [];
      let count = 0;
      for (const [key, val] of Object.entries(value)) {
        if (val !== undefined && typeof val !== 'function') {
          entries.push(JSON.stringify(key) + ':' + await stringify(val, visited));
          if (++count % 10 === 0) await checkAndYield('object key');
        }
      }
      return '{' + entries.join(',') + '}';
    }

    // Can add timeout support
    const timeoutMs = 5000;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        aborted = true;
        reject(new Error('Timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
    });

    // Race between stringify and timeout
    return await Promise.race([
      stringify(obj),
      timeoutPromise
    ]);
  }
};

// ============================================================================
// Demonstration & Comparison
// ============================================================================

async function demonstrateMigration() {
  console.log('='.repeat(80));
  console.log('FIBER TO ASYNC/AWAIT MIGRATION EXAMPLE');
  console.log('='.repeat(80));

  // Create test data
  const testObject = {
    level1: Array(100).fill(null).map((_, i) => ({
      id: i,
      data: 'x'.repeat(100),
      nested: {
        value: Math.random(),
        items: Array(10).fill(null).map((_, j) => ({
          idx: j,
          text: 'test'
        }))
      }
    }))
  };

  console.log('\nTest object created with ~100KB of data\n');

  // Test fiber implementation (if available)
  const fiberImpl = createFiberImplementation();
  if (fiberImpl) {
    console.log('1. FIBER-BASED IMPLEMENTATION:');
    console.log('   Using Fiber.yield() for non-blocking...');

    const start = Date.now();
    try {
      const result = fiberImpl.incremental_json_stringify(testObject);
      console.log(`   ✅ Success in ${Date.now() - start}ms`);
      console.log(`   Result size: ${(result.length / 1024).toFixed(1)} KB`);
    } catch (error) {
      console.log(`   ❌ Error: ${error.message}`);
    }
  } else {
    console.log('1. FIBER-BASED: Not available (requires Node 14 + fibers)');
  }

  // Test async implementation
  console.log('\n2. ASYNC/AWAIT IMPLEMENTATION:');
  console.log('   Using await + setImmediate for non-blocking...');

  const start = Date.now();
  try {
    const result = await AsyncImplementation.incremental_json_stringify(testObject);
    console.log(`   ✅ Success in ${Date.now() - start}ms`);
    console.log(`   Result size: ${(result.length / 1024).toFixed(1)} KB`);
  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
  }

  // Show migration patterns
  console.log('\n' + '='.repeat(80));
  console.log('MIGRATION PATTERNS:');
  console.log('='.repeat(80));

  console.log(`
1. Replace Fiber wrapper:
   Before: const fiber = Fiber(() => { ... }); fiber.run();
   After:  await asyncFunction();

2. Replace optional_pause:
   Before: Fiber.yield()
   After:  await new Promise(r => setImmediate(r))

3. Make functions async:
   Before: function stringify(obj) { ... }
   After:  async function stringify(obj) { ... }

4. Add await to recursive calls:
   Before: stringify(value)
   After:  await stringify(value)

5. Add timeout support:
   Before: Manual fiber.throwInto() on timeout
   After:  Promise.race([work, timeout]) or AbortController

6. Error handling:
   Before: try/catch in fiber
   After:  try/catch with async/await
`);

  console.log('='.repeat(80));
  console.log('BENEFITS OF ASYNC/AWAIT APPROACH:');
  console.log('- No special runtime required (works with all Node.js versions)');
  console.log('- Standard JavaScript patterns');
  console.log('- Better debugging and stack traces');
  console.log('- Cleaner timeout and cancellation');
  console.log('- Future-proof (fibers are deprecated)');
  console.log('='.repeat(80));
}

// Run demonstration
if (require.main === module) {
  demonstrateMigration().catch(console.error);
}

module.exports = {
  createFiberImplementation,
  AsyncImplementation
};