const { parentPort, workerData } = require('worker_threads');

// Simple worker that stringifies the object
const result = JSON.stringify(workerData);
parentPort.postMessage(result);