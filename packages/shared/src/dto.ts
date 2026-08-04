/**
 * REST DTO 统一出口（spec §2：所有接口请求/响应类型在 shared/src/dto.ts 定义并导出）
 * 实体按域拆在 types/ 下，此处聚合导出，服务端与客户端统一从这里 import。
 */
export * from './types/handoff.js';
export * from './types/bot.js';
export * from './types/runner.js';
export * from './types/manifest.js';
