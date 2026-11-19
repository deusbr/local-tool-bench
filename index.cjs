'use strict';

const { extractJsonCandidate, validateAndRepairArgs } = require('./lib/repair.cjs');
const { DEFAULT_CASES, runBenchmark } = require('./lib/bench.cjs');
const { createRepairProxy } = require('./lib/proxy.cjs');

module.exports = {
  extractJsonCandidate,
  validateAndRepairArgs,
  DEFAULT_CASES,
  runBenchmark,
  createRepairProxy
};