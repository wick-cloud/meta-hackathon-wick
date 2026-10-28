import type { WickTerminal, WickTerminalEvent, WickTerminalOptions } from './types.js';

/** In-memory simulation only. No subprocess, workload, disk access, or real environment. */
export function fixtureTerminal(options: WickTerminalOptions = {}): WickTerminal {
  const queue: WickTerminalEvent[] = [{ type: 'ready' }];
  let wake: (() => void) | undefined;
  let finished = false;
  let line = '';
  let queuedBytes = 0;
  const send = (event: WickTerminalEvent) => {
    if (finished) return;
    if (event.type === 'output') queuedBytes += event.data.byteLength;
    if (queue.length >= 256 || queuedBytes > 256 * 1024) {
      close();
      return;
    }
    queue.push(event);
    wake?.();
  };
  const output = (data: string) => send({ type: 'output', data: Buffer.from(data, 'utf8') });
  function close() {
    finished = true;
    line = '';
    options.signal?.removeEventListener('abort', close);
    wake?.();
  }
  options.signal?.addEventListener('abort', close, { once: true });
  const fixtureCommand = (command: string) => {
    const trimmed = command.trim();
    if (!trimmed) return;
    if (trimmed === 'help')
      output(
        'Simulated demo terminal. No commands run on a real VM.\r\nTry: help, pwd, whoami, ls, date, echo <text>, clear, exit.\r\n',
      );
    else if (trimmed === 'pwd') output('/workspace (simulated)\r\n');
    else if (trimmed === 'whoami') output('demo-customer (simulated)\r\n');
    else if (trimmed === 'ls') output('This simulated workspace has no real files.\r\n');
    else if (trimmed === 'date') output(`${new Date().toISOString()} (broker clock)\r\n`);
    else if (trimmed === 'clear') output('\x1b[2J\x1b[H');
    else if (trimmed.startsWith('echo ')) output(`${trimmed.slice(5)}\r\n`);
    else if (trimmed === 'exit') {
      send({ type: 'exit', exitCode: 0 });
      close();
    } else
      output(
        'Simulation only: this command was not executed. Type help for available demo interactions.\r\n',
      );
  };
  const fixtureInput = (data: string) => {
    let echo = '';
    const flush = () => {
      if (echo) {
        output(echo);
        echo = '';
      }
    };
    for (const character of data) {
      if (finished) return;
      if (character === '\r' || character === '\n') {
        echo += '\r\n';
        flush();
        fixtureCommand(line);
        line = '';
        if (!finished) output('\x1b[32mwick-demo\x1b[0m $ ');
      } else if (character === '\x03') {
        line = '';
        echo += '^C\r\n\x1b[32mwick-demo\x1b[0m $ ';
      } else if (character === '\x04') {
        flush();
        send({ type: 'exit', exitCode: 0 });
        close();
      } else if (character === '\x7f' || character === '\b') {
        if (line.length) {
          line = line.slice(0, -1);
          echo += '\b \b';
        }
      } else if (character >= ' ' && character !== '\x7f') {
        if (Buffer.byteLength(line) > 8192) {
          close();
          return;
        }
        line += character;
        echo += character;
      }
    }
    flush();
  };

  output(
    '\x1b[1mWick Broker · simulated demo terminal\x1b[0m\r\nNo real VM is allocated. Commands here are simulated; nothing runs on the app server.\r\nYour rental clock continues when you disconnect. Type help to explore.\r\n\r\n\x1b[32mwick-demo\x1b[0m $ ',
  );
  if (options.signal?.aborted) close();
  return {
    input: fixtureInput,
    resize: () => undefined,
    ack: () => undefined,
    close,
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          const event = queue.shift();
          if (event) {
            if (event.type === 'output') queuedBytes -= event.data.byteLength;
            yield event;
          } else if (finished) return;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        close();
      }
    },
  };
}
