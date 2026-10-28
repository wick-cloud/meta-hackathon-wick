import { describe, expect, it } from 'vitest';
import { TerminalMarkerProof } from '../scripts/live-scale/terminal-proof.js';

const marker = 'BROKER_SCALE_unique_nonce_1';
const bytes = (value: string) => Buffer.from(value);

describe('bounded real terminal diagnostic proof (offline)', () => {
  it('requires an entire completed marker output line and rejects command echo alone', () => {
    const proof = new TerminalMarkerProof(marker);
    expect(proof.push(bytes(`shell$ printf '%s\\n' '${marker}'\r\n`))).toBe(false);
    expect(proof.push(bytes(marker))).toBe(false);
    expect(proof.push(bytes('\r'))).toBe(false);
    expect(proof.push(bytes('\n'))).toBe(true);
    expect(proof.matched).toBe(true);
  });

  it('requires a leading output delimiter when an echo-off shell leaves a prompt on the current line', () => {
    const unframed = new TerminalMarkerProof(marker);
    expect(unframed.push(bytes(`synthetic-shell$ ${marker}\r\n`))).toBe(false);
    const framed = new TerminalMarkerProof(marker);
    expect(framed.push(bytes(`synthetic-shell$ \r\n${marker}\r\n`))).toBe(true);
  });

  it('handles CSI bracketed-paste, OSC BEL/ST, CR and UTF-8 split across every byte', () => {
    const proof = new TerminalMarkerProof(marker);
    const output = bytes(
      `\x1b]0;shell title é\x07shell$ printf '%s\\n' '${marker}'\r\n` +
        `\x1b[?2004l\r\x1b]2;another title\x1b\\\x1b[32m${marker}\x1b[0m\r\n`,
    );
    for (const byte of output.subarray(0, -1)) expect(proof.push(Uint8Array.of(byte))).toBe(false);
    expect(proof.push(output.subarray(-1))).toBe(true);
  });

  it('does not match marker text hidden in an OSC title or longer lines', () => {
    const proof = new TerminalMarkerProof(marker);
    expect(proof.push(bytes(`\x1b]0;${marker}\n\x07prefix${marker}\r\n`))).toBe(false);
    expect(proof.push(bytes(`${marker}suffix\n`))).toBe(false);
    expect(proof.push(bytes(`${marker}\n`))).toBe(true);
  });

  it('discards oversized lines without accepting their marker suffix', () => {
    const proof = new TerminalMarkerProof(marker);
    expect(proof.push(bytes(`${'x'.repeat(9000)}${marker}\n`))).toBe(false);
    expect(proof.push(bytes(`${marker}\n`))).toBe(true);
  });

  it('bounds unfinished control sequences and total pre-proof output', () => {
    const control = new TerminalMarkerProof(marker);
    expect(() => control.push(bytes(`\x1b]${'x'.repeat(4097)}`))).toThrow('control sequence');
    const output = new TerminalMarkerProof(marker);
    for (let index = 0; index < 8; index++) output.push(bytes('x'.repeat(32 * 1024)));
    expect(() => output.push(bytes('x'))).toThrow('byte limit');
  });
});
