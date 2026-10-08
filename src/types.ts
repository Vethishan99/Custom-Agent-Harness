export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  // Provider data that must be sent back unchanged, such as Gemini's
  // thought signatures ({google: {thought_signature}}).
  extra_content?: unknown;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  // Provider-native content to send back unchanged on the next request
  // (for example Anthropic thinking blocks, which must round-trip exactly).
  providerRaw?: unknown;
}

export type Message =
  | {role: 'system' | 'user'; content: string}
  | AssistantMessage
  | {role: 'tool'; tool_call_id: string; content: string};

// A type alias (not an interface) so it's assignable to SDK schema types.
export type ObjectSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

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
  // Receives the model's reply text as it is generated.
  stream?(text: string): void;
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

export interface AgentRunResult {
  messages: Message[];
  answer: string;
}

// One model backend. Adapters translate the internal OpenAI-shaped messages
// into their own wire format and back.
export interface Provider {
  name: string;
  model: string;
  // Whether old turns may be dropped to save context. Providers that bind
  // reasoning to the exact history (Anthropic) must keep it append-only.
  canTrimHistory: boolean;
  // onText receives reply text as it streams in; the returned message is
  // still the complete reply.
  complete(
    messages: Message[],
    tools: ToolSpec[],
    onText?: (text: string) => void,
  ): Promise<AssistantMessage>;
}
