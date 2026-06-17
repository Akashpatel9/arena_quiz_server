/**
 * Build an EXPECTED (rule-violation) error. `expected: true` tells the socket
 * layer to return { code, message } to the client instead of logging it as a
 * crash.
 */
export function expectedError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.expected = true;
  return e;
}
