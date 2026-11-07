import { F0JsonValueZod } from '../../../src/sajimora/certified/schemas';

console.log('Testing PR1.x Schema Hardening for OpaqueF0Payload');

function expectRejection(name: string, value: any) {
  const res = F0JsonValueZod.safeParse(value);
  if (res.success) {
    throw new Error(`FAIL: Schema unexpectedly accepted ${name}`);
  }
  console.log(`✅ PASS: Schema correctly rejected ${name}`);
}

function expectAcceptance(name: string, value: any) {
  const res = F0JsonValueZod.safeParse(value);
  if (!res.success) {
    throw new Error(`FAIL: Schema unexpectedly rejected ${name}`);
  }
  console.log(`✅ PASS: Schema correctly accepted ${name}`);
}

try {
  expectRejection('Infinity', Infinity);
  expectRejection('-Infinity', -Infinity);
  expectRejection('NaN', NaN);
  expectRejection('Unpaired Surrogate 1', '\uD800');
  expectRejection('Unpaired Surrogate 2', 'test\uD800test');
  
  expectAcceptance('Finite Number', 42);
  expectAcceptance('Zero', 0);
  expectAcceptance('Negative Finite', -100);
  expectAcceptance('Standard String', 'hello world');
  expectAcceptance('Valid Emoji (Paired Surrogates)', '🚀');
  expectAcceptance('Plain Object', { key: 'value' });
  expectAcceptance('Nested Valid Object', { a: [1, 2, 3], b: true, c: null });
  expectAcceptance('Boolean', true);
  expectAcceptance('Null', null);
  
  console.log('All hardening assertions passed successfully.');
} catch (err: any) {
  console.error(err.message);
  process.exit(1);
}
