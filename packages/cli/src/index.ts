#!/usr/bin/env node
/**
 * agenthub CLI（spec §4.7 命令面）
 */
import { basename } from 'node:path';
import { Command } from 'commander';
import { getRepoInfo } from '@agenthub/shared';
import { HubClient, HubApiError } from './api.js';
import { configPath, loadConfig, saveConfig } from './config.js';
import { ask, askSecret } from './prompt.js';
import { runPush } from './push.js';
import { runPull } from './pull.js';

const program = new Command();

program.name('agenthub').description('本地 Coding Agent Session 的云端接力平台').version('0.1.0');

function fail(err: unknown): never {
  if (err instanceof HubApiError) {
    const hint =
      err.code === 'ERR_AUTH'
        ? '\n  提示: token 缺失或已过期（有效期 7 天），请重新执行 ah login 获取（首次用 --register）'
        : '';
    console.error(`✗ [${err.code}] ${err.message}${hint}`);
  } else console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

program
  .command('login')
  .description('登录 Hub（token 存 ~/.agenthub/config.json）')
  .option('--hub <url>', 'Hub 地址')
  .option('--register', '注册新用户')
  .action(async (opts: { hub?: string; register?: boolean }) => {
    try {
      const cfg = loadConfig();
      if (opts.hub) cfg.hubUrl = opts.hub;
      const username = await ask('用户名: ');
      const password = await askSecret('密码: ');
      const client = new HubClient(cfg);
      const resp = opts.register ? await client.register(username, password) : await client.login(username, password);
      saveConfig({ ...cfg, token: resp.token });
      console.log(`✓ 已登录 ${cfg.hubUrl}（${resp.user.username}），配置写入 ${configPath()}`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('push')
  .description('打包当前 repo + session 移交云端')
  .option('--session <id>', '指定 session（缺省取最近活跃）')
  .option('--task <指令>', '接力指令；缺省为交互接力（云端挂起等对话）')
  .option('--no-include-untracked', '快照不含未跟踪文件（缺省含，遵循 .gitignore）')
  .option('--bot <name>', '推到常驻钉钉机器人 sandbox')
  .option('--chat <chatId>', '绑定到指定钉钉群（配合 --bot）')
  .option('--timeout <min>', '任务接力硬超时分钟数', '30')
  .action(async (opts) => {
    try {
      await runPush(opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('pull')
  .description('拉回返回包：git 合并 + 会话时间线合并（幂等）')
  .argument('[handoff-id]', '缺省拉当前仓库最近一次已完成任务')
  .option('--branch', '云端 commit 落到独立分支 agenthub/<handoff-id>')
  .action(async (id: string | undefined, opts) => {
    try {
      await runPull(id, opts);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('list')
  .description('列出 handoff 任务')
  .option('--all', '所有仓库（缺省仅当前仓库）')
  .action(async (opts: { all?: boolean }) => {
    try {
      const client = new HubClient(loadConfig());
      const query = opts.all ? {} : { agentName: basename(getRepoInfo(process.cwd()).root) };
      const { items } = await client.listHandoffs(query);
      if (items.length === 0) {
        console.log('（空）');
        return;
      }
      for (const h of items) {
        console.log(
          `${h.id}  ${h.status.padEnd(12)} ${h.kind.padEnd(4)} ${h.agentName}@${h.branch}  ${h.task ?? '(交互接力)'}  ${h.createdAt}`,
        );
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('status')
  .description('查看任务状态与时间线')
  .argument('<handoff-id>')
  .action(async (id: string) => {
    try {
      const h = await new HubClient(loadConfig()).getHandoff(id);
      console.log(`${h.id}  ${h.status}  ${h.agentName}@${h.branch}`);
      for (const t of h.timeline) console.log(`  ${t.at}  ${t.status}`);
      if (h.result) console.log(`结果: ${JSON.stringify(h.result)}`);
      if (h.downloadUrl) console.log(`可执行 agenthub pull ${h.id} 拉回`);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('cancel')
  .description('取消任务（执行中会先打包部分成果）')
  .argument('<handoff-id>')
  .action(async (id: string) => {
    try {
      const r = await new HubClient(loadConfig()).cancel(id);
      console.log(`✓ ${id} → ${r.status}`);
    } catch (e) {
      fail(e);
    }
  });

program.parse();
