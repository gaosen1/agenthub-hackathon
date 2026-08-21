/**
 * 浏览器安全入口（hub-web 用）：仅纯契约（zod schema + 类型），
 * 不含 pack/merge/git 等依赖 node:* 的模块。
 * 通过 `@agenthub/shared/contracts` 引入。
 */
export * from './manifest.js';
export * from './dto.js';
export * from './runner.js';
export * from './acp.js';
// 显式 re-export：vite/esbuild 预打包不一定追踪 export * 下的新增符号
export { RunnerIdeStatusRespSchema } from './runner.js';
