export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export type Message =
  | {role: 'system' | 'user'; content: string}
  | AssistantMessage
  | {role: 'tool'; tool_call_id: string; content: string};

export interface ObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ObjectSchema;
  };
}

export interface AgentHooks {
  emit(text: string): void;
  approve(action: string): Promise<boolean>;
}

export interface ToolContext extends AgentHooks {
  workspaceRoot: string;
}

export interface ToolSpec {
  definition: ToolDefinition;
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<unknown>;
}

export type ToolExecutionResult =
  | {ok: true; data: unknown}
  | {ok: false; error: string};

export interface ChatCompletionResponse {
  choices: Array<{
    message: AssistantMessage;
  }>;
}

export interface AgentRunResult {
  messages: Message[];
  answer: string;
}