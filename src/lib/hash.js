'use strict';

const crypto = require('node:crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { sha256 };
