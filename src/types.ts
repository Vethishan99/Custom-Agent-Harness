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