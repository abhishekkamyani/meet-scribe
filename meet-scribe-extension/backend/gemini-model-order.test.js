const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('./server.js', 'utf8');
const defaultModelMatch = source.match(/const DEFAULT_GEMINI_MODEL = '([^']+)'/);
assert.ok(defaultModelMatch, 'DEFAULT_GEMINI_MODEL definition not found');
assert.equal(defaultModelMatch[1], 'gemini-3.5-flash', 'Default Gemini model should be gemini-3.5-flash');

const functionStart = source.indexOf('function geminiModelCandidates()');
const functionEnd = source.indexOf('function isQuotaExceededError');
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'geminiModelCandidates function not found');

const candidateBlock = source.slice(functionStart, functionEnd);
const ordered = candidateBlock.match(/'([^']+)'/g).map(v => v.slice(1, -1));
const gemini35 = ordered.indexOf('gemini-3.5-flash');
const gemini36 = ordered.indexOf('gemini-3.6-flash');
const gemini31 = ordered.indexOf('gemini-3.1-pro-preview');
const gemini25 = ordered.indexOf('gemini-2.5-flash');
const gemini30 = ordered.indexOf('gemini-3.0-flash');

assert.ok(gemini35 >= 0, 'gemini-3.5-flash should be present');
assert.ok(gemini36 >= 0, 'gemini-3.6-flash should be present');
assert.ok(gemini35 < gemini36, 'gemini-3.5-flash should be preferred over gemini-3.6-flash');
assert.equal(gemini31, -1, 'gemini-3.1-pro-preview should not be in the fallback list');
assert.equal(gemini25, -1, 'gemini-2.5-flash should not be in the fallback list');
assert.equal(gemini30, -1, 'gemini-3.0-flash should not be in the fallback list');

assert.match(source, /No API keys configured|BYOK|extension.*keys/i, 'Backend should reject requests when no effective API keys are supplied');
assert.match(source, /No English transcript captured for this recording|No specific action items were identified/i, 'Partial Gemini responses should be normalized with default English and action-item content');

console.log('Gemini model precedence test passed.');
