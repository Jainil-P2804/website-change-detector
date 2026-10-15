'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const config = require('../config');

/**
 * Minimal artifact store on local disk / mounted volume. Swap these three
 * functions for S3/GCS calls to run the workers and API on separate hosts.
 */
const root = path.resolve(config.artifactDir);

/** Resolves a relative artifact path and refuses to leave the artifact root. */
function abs(rel) {
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Invalid artifact path');
  return full;
}

async function save(rel, buffer) {
  const full = abs(rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return rel;
}

async function read(rel) {
  return fs.readFile(abs(rel));
}

module.exports = { abs, save, read };
