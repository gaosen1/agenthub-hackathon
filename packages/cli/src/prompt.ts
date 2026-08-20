/**
 * 终端交互输入（§4.7 login）：
 * - ask：普通输入，回显；
 * - askSecret：敏感输入，TTY 下 raw 模式不回显（Enter 结束 / Ctrl+C 退出 / 退格可改）；
 *   非 TTY（管道/脚本）退化为逐行读取：不回显、提示走 stderr、已到达的行不丢失，
 *   EOF 时抛 InputEOFError（避免静默退出）。
 */
import { createInterface, type Interface as ReadlineInterface } from 'node:readline/promises';

export class InputEOFError extends Error {
  constructor() {
    super('stdin 已结束，未能读齐输入（管道使用时请每行提供用户名、密码）');
    this.name = 'InputEOFError';
  }
}

/** 非 TTY 行队列：line 事件先于 question 到达时入队缓冲，close 后未决请求收到 undefined */
let piped: { next: () => Promise<string | undefined> } | undefined;
function pipedLines() {
  if (piped) return piped;
  const rl: ReadlineInterface = createInterface({ input: process.stdin, output: undefined });
  const buffer: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let closed = false;
  rl.on('line', (line) => {
    const w = waiters.shift();
    if (w) w(line);
    else buffer.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()!(undefined);
  });
  piped = {
    next: () => {
      const buffered = buffer.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (closed) return Promise.resolve(undefined);
      return new Promise((r) => waiters.push(r));
    },
  };
  return piped;
}

async function readPipedLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const line = await pipedLines().next();
  if (line === undefined) throw new InputEOFError();
  return line.trim();
}

/** 普通输入（回显） */
export async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** 敏感输入（不回显） */
export async function askSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine(prompt);
  return await new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
        } else if (ch === '\u0003') {
          // Ctrl+C：恢复终端状态后按惯例退出
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}
