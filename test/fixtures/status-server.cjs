const readline = require('node:readline');
const [mode, delay] = process.argv.slice(2);
let initialized = false;
let experimental = false;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    experimental = request.params.capabilities?.experimentalApi === true;
    setTimeout(() => send({ id: request.id, result: { userAgent: 'fixture' } }), Number(delay));
  } else if (request.method === 'initialized') {
    initialized = true;
  } else if (!initialized) {
    send({ id: request.id, error: { code: -32600, message: 'Not initialized' } });
  } else if (request.method === 'account/rateLimits/read') {
    send(mode === 'rate-error'
      ? { id: request.id, error: { code: -32000, message: 'Not logged in' } }
      : { id: request.id, result: { rateLimits: { planType: 'pro', secondary: {
        usedPercent: 42, windowDurationMins: 10080, resetsAt: 2000000000,
      } } } });
  } else if (request.method === 'account/usage/read') {
    setTimeout(() => send(mode === 'unsupported' || !experimental
      ? { id: request.id, error: { code: -32601, message: 'Method not found' } }
      : { id: request.id, result: { dailyUsageBuckets: [{ startDate: '2026-09-05', tokens: 1000 }] } }), 40);
  }
});
