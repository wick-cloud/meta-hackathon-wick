// A bounded streaming proof reader, not a transcript or terminal emulator. Shells may
// place bracketed-paste CSI controls or OSC titles around a completed marker line.
// Only an entire newline-terminated plain line can prove execution; command echo cannot.
export class TerminalMarkerProof {
  private readonly decoder = new TextDecoder();
  private state: 'text' | 'escape' | 'csi' | 'osc' | 'osc-escape' = 'text';
  private line = '';
  private lineOverflow = false;
  private controlLength = 0;
  private bytes = 0;
  private found = false;

  constructor(private readonly marker: string) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(marker)) throw new Error('Invalid terminal proof marker.');
  }

  get matched(): boolean {
    return this.found;
  }

  push(bytes: Uint8Array): boolean {
    if (this.found) return true;
    this.bytes += bytes.byteLength;
    if (this.bytes > 256 * 1024) throw new Error('Terminal proof output exceeded its byte limit.');
    for (const char of this.decoder.decode(bytes, { stream: true })) {
      if (this.state !== 'text' && ++this.controlLength > 4096)
        throw new Error('Terminal proof control sequence exceeded its limit.');
      if (this.state === 'osc') {
        if (char === '\x07' || char === '\x9c') this.state = 'text';
        else if (char === '\x1b') this.state = 'osc-escape';
        continue;
      }
      if (this.state === 'osc-escape') {
        if (char === '\\' || char === '\x07' || char === '\x9c') this.state = 'text';
        else if (char !== '\x1b') this.state = 'osc';
        continue;
      }
      if (this.state === 'csi') {
        if (char >= '@' && char <= '~') this.state = 'text';
        continue;
      }
      if (this.state === 'escape') {
        this.state = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text';
        continue;
      }
      if (char === '\x1b' || char === '\x9b' || char === '\x9d') {
        this.controlLength = 0;
        this.state = char === '\x1b' ? 'escape' : char === '\x9b' ? 'csi' : 'osc';
      } else if (char === '\n') {
        this.found = !this.lineOverflow && this.line === this.marker;
        this.line = '';
        this.lineOverflow = false;
        if (this.found) return true;
      } else if (char !== '\r') {
        if (this.line.length + char.length > 8192) {
          this.lineOverflow = true;
          this.line = '';
        } else if (!this.lineOverflow) this.line += char;
      }
    }
    return false;
  }
}
