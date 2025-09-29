#!/usr/bin/env node

/**
 * Clear demonstration of timeout-based interruption
 */

// ============================================================================
// Create a massive object that will definitely timeout
// ============================================================================

function createMassiveObject() {
  const obj = {
    level1: {}
  };

  // Create a deeply nested structure that takes significant time to serialize
  for (let i = 0; i < 1000; i++) {
    obj.level1[`key_${i}`] = {
      data: 'x'.repeat(1000),
      nested: Array(100).fill(null).map((_, j) => ({
        id: `${i}_${j}`,
        value: Math.random(),
        text: 'y'.repeat(100)
      }))
    };
  }

  return obj;
}

// ============================================================================
// Async/Await with Clear Timeout
// ============================================================================

async function serializeWithTimeout(obj, timeoutMs) {
  const startTime = Date.now();
  let operationCount = 0;
  let lastYield = Date.now();
  let aborted = false;

  // Set up timeout
  const timeoutId = setTimeout(() => {
    aborted = true;
    console.log(`   ⏰ Timeout triggered at ${timeoutMs}ms`);
  }, timeoutMs);

  async function yieldControl() {
    operationCount++;

    if (aborted) {
      throw new Error('Operation cancelled due to timeout');
    }

    // Yield every 5ms or every 100 operations
    const now = Date.now();
    if (now - lastYield > 5 || operationCount > 100) {
      console.log(`   📊 Progress: ${operationCount} operations, ${now - startTime}ms elapsed`);
      await new Promise(resolve => setImmediate(resolve));
      lastYield = Date.now();
      operationCount = 0;
    }
  }

  async function stringify(value, depth = 0) {
    await yieldControl();

    if (value === null || value === undefined) return 'null';

    const type = typeof value;
    if (type !== 'object') return JSON.stringify(value);

    if (Array.isArray(value)) {
      const parts = [];
      for (const item of value) {
        parts.push(await stringify(item, depth + 1));
      }
      return '[' + parts.join(',') + ']';
    }

    const entries = [];
    for (const [key, val] of Object.entries(value)) {
      if (val !== undefined && typeof val !== 'function') {
        entries.push(JSON.stringify(key) + ':' + await stringify(val, depth + 1));
      }
    }
    return '{' + entries.join(',') + '}';
  }

  try {
    console.log(`   🚀 Starting serialization with ${timeoutMs}ms timeout...`);
    const result = await stringify(obj);
    clearTimeout(timeoutId);
    console.log(`   ✅ Completed successfully in ${Date.now() - startTime}ms`);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    const elapsed = Date.now() - startTime;
    console.log(`   ❌ Interrupted after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// Main Demo
// ============================================================================

async function runDemo() {
  console.log('='.repeat(80));
  console.log('TIMEOUT INTERRUPTION DEMONSTRATION');
  console.log('='.repeat(80));
  console.log('\nCreating a massive object that would take many seconds to serialize...\n');

  const massiveObj = createMassiveObject();

  // Test 1: Try with native JSON.stringify (will complete but block)
  console.log('1. NATIVE JSON.stringify (no timeout capability):');
  console.log('   ⚠️  This will block the event loop...');
  const t1 = Date.now();
  try {
    const result = JSON.stringify(massiveObj);
    console.log(`   Completed in ${Date.now() - t1}ms (${(result.length / 1024 / 1024).toFixed(2)} MB)`);
  } catch (e) {
    console.log(`   Failed: ${e.message}`);
  }

  // Test 2: With 100ms timeout (will timeout)
  console.log('\n2. ASYNC with 100ms timeout:');
  try {
    await serializeWithTimeout(massiveObj, 100);
  } catch (e) {
    console.log(`   Expected timeout occurred ✓`);
  }

  // Test 3: With 500ms timeout (might complete or timeout)
  console.log('\n3. ASYNC with 500ms timeout:');
  try {
    await serializeWithTimeout(massiveObj, 500);
  } catch (e) {
    console.log(`   Timeout occurred as expected ✓`);
  }

  // Test 4: Demonstrate non-blocking nature
  console.log('\n4. NON-BLOCKING TEST (with background work):');
  console.log('   Running serialization while performing other work...');

  let backgroundCounter = 0;
  const backgroundWork = setInterval(() => {
    backgroundCounter++;
    if (backgroundCounter % 10 === 0) {
      console.log(`   🔄 Background work: ${backgroundCounter} iterations completed`);
    }
  }, 10);

  try {
    await serializeWithTimeout(massiveObj, 300);
  } catch (e) {
    // Expected timeout
  }

  clearInterval(backgroundWork);
  console.log(`   📊 Background work completed ${backgroundCounter} iterations during serialization`);
  console.log(`   ✅ Event loop remained responsive!`);

  console.log('\n' + '='.repeat(80));
  console.log('KEY TAKEAWAYS:');
  console.log('- Async/await approach can be cleanly interrupted by timeout');
  console.log('- Event loop remains responsive during serialization');
  console.log('- Background work continues to run concurrently');
  console.log('- No special runtime (fibers) required - pure JavaScript');
  console.log('='.repeat(80));
}

// Run demo
if (require.main === module) {
  runDemo().catch(console.error);
}