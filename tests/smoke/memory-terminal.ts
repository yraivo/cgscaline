import { PassThrough, Writable } from 'node:stream';

/** Isolated terminal for smoke tests; never consumes the test runner's stdin. */
export function memoryTerminal(columns = 118, rows = 38) {
  let output = '';
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
  });
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) {
    output += String(chunk); done();
  }}), { isTTY: true, columns, rows });
  return { stdin, stdout, read: () => output, dispose() { stdin.destroy(); stdout.destroy(); } };
}
