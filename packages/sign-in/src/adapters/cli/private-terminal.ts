/** Restores the terminal on completion or interruption and never echoes a password. */
import { createInterface } from 'node:readline/promises';

import type { PrivateTerminal } from './setup-command.js';

export function privateTerminal(): PrivateTerminal {
  return {
    isTerminal: process.stdin.isTTY && process.stdout.isTTY,
    async prompt(label) {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try { return await terminal.question(`${label}: `); }
      finally { terminal.close(); }
    },
    privatePassword: readPassword,
    write: (line) => { process.stdout.write(`${line}\n`); },
  };
}

function readPassword(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.reject(new Error('A private terminal is required'));
  return new Promise((resolve, reject) => {
    const wasRaw = process.stdin.isRaw;
    let password = '';
    process.stdout.write('Password: ');
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    const done = () => {
      process.stdin.off('data', received);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const received = (value: string) => {
      for (const character of value) {
        if (character === '\u0003' || character === '\u0004') { done(); reject(new Error('Setup cancelled')); return; }
        if (character === '\r' || character === '\n') { done(); resolve(password); return; }
        if (character === '\u007f' || character === '\b') password = password.slice(0, -1);
        else if (character >= ' ' && password.length < 1024) password += character;
      }
    };
    process.stdin.on('data', received);
  });
}
