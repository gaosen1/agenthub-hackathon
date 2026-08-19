/**
 * §4.4 ACP over HTTP 最小消息子集（hub-web 与 runner 共用）
 * 传输：POST /acp（提交，202）+ GET /acp（SSE 收流）+ DELETE /acp（关连接）
 * 头：Acp-Connection-Id / Acp-Session-Id / Last-Event-ID
 */

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: '2.0';
  id: number;
  result?: R;
  error?: { code: number; message: string; data?: unknown };
}

/** 服务端主动通知帧（无 id） */
export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params: P;
}

export type AcpFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------- 客户端方法参数 ----------

export interface InitializeParams {
  protocolVersion: 1;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
}

export interface SessionNewParams {
  cwd: string;
}

export interface PromptBlock {
  type: 'text';
  text: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: PromptBlock[];
}

// ---------- 服务端事件 ----------

/** session/update 通知：增量输出/工具调用，按 params.update.sessionUpdate 分派 */
export interface SessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
}

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionLoad: 'session/load',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionPermissionResponse: 'session/permission_response',
  // 服务端 → 客户端
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
} as const;
