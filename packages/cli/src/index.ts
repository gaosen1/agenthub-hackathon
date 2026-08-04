#!/usr/bin/env node
/**
 * agenthub CLI 入口（design.md §5.1）
 * push / pull / status / list / cancel / login
 */
import { Command } from 'commander';
import { HANDOFF_STATES } from '@agenthub/shared';

const program = new Command();

program
  .name('agenthub')
  .description('本地 Coding Agent Session 的云端接力平台')
  .version('0.1.0');

program
  .command('push')
  .description('打包当前 repo + session 移交云端（F-1）')
  .option('--session <id>', '指定 session id')
  .option('--task <指令>', '任务接力指令；缺省为交互接力')
  .option('--include-untracked', '包含未跟踪文件')
  .option('--bot <botName>', '推到常驻钉钉机器人')
  .option('--chat <chatId>', '绑定到指定群')
  .action(() => {
    console.log('TODO: agenthub push（M1 实现）');
  });

program
  .command('pull')
  .description('拉回返回包并合并代码与会话（F-2）')
  .argument('[handoff-id]', '缺省拉当前仓库最近一次已完成任务')
  .option('--branch', '云端 commit 落到独立分支 agenthub/<handoff-id>')
  .action(() => {
    console.log('TODO: agenthub pull（M1 实现）');
  });

program
  .command('login')
  .description('登录 Hub，token 存 ~/.agenthub/config（F-6）')
  .action(() => {
    console.log('TODO: agenthub login（M1 实现）');
  });

program
  .command('list')
  .description('列出 handoff 任务（F-5）')
  .action(() => {
    console.log(`TODO: agenthub list（状态：${HANDOFF_STATES.join(' | ')}）`);
  });

program.parse();
