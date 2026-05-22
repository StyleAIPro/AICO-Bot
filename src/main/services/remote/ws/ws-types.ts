/**
 * Remote WebSocket - Type Definitions
 */

export interface RemoteWsClientConfig {
  serverId: string;
  host: string;
  port: number;
  authToken: string;
  useSshTunnel?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface ClientMessage {
  type:
    | 'auth'
    | 'claude:chat'
    | 'fs:list'
    | 'fs:read'
    | 'fs:write'
    | 'fs:upload'
    | 'fs:download'
    | 'fs:delete'
    | 'fs:stat'
    | 'fs:mkdir'
    | 'ping'
    | 'tool:approve'
    | 'tool:reject'
    | 'mcp:tools:register'
    | 'mcp:tool:response'
    | 'mcp:tool:error'
    | 'ask:answer'
    | 'permission:response'
    | 'task:list'
    | 'task:cancel'
    | 'task:spawn';
  sessionId?: string;
  payload?: any;
}

export interface ServerMessage {
  type:
    | 'auth:success'
    | 'auth:failed'
    | 'claude:stream'
    | 'claude:complete'
    | 'claude:error'
    | 'claude:session'
    | 'claude:usage'
    | 'claude:context-usage'
    | 'fs:result'
    | 'fs:error'
    | 'pong'
    | 'ping'
    | 'tool:call'
    | 'tool:delta'
    | 'tool:result'
    | 'tool:error'
    | 'terminal:output'
    | 'thought'
    | 'thought:delta'
    | 'mcp:status'
    | 'compact:boundary'
    | 'text:block-start'
    | 'mcp:tool:call'
    | 'mcp:tool:response'
    | 'task:update'
    | 'task:list'
    | 'task:get'
    | 'task:cancel'
    | 'task:spawn'
    | 'worker:started'
    | 'worker:completed'
    | 'ask:question'
    | 'permission:request'
    | 'stream:alive'
    | 'log';
  sessionId?: string;
  generationId?: string;
  data?: any;
}

export interface ToolCallData {
  id: string;
  name: string;
  input: any;
  status: 'started' | 'delta' | 'result' | 'error';
  output?: any;
  error?: string;
}

export interface TerminalOutputData {
  content: string;
  type: 'stdout' | 'stderr';
}
