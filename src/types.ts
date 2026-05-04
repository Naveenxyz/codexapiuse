export interface Account {
  /** Stable local numeric ID used for account selection/storage. */
  id: number;
  /** Human label, e.g. work/personal. */
  name: string;
  access?: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CustomRouteObject {
  /** Account id or account name. */
  account: number | string;
  /** Upstream Codex model, e.g. gpt-5.5. */
  model: string;
  /** Codex reasoning effort. */
  reasoning: ReasoningEffort;
}

export type CustomRouteValue = CustomRouteObject | string;

export interface ConfigFile {
  version: 1;
  nextId: number;
  accounts: Account[];
  /** Extra user-defined model IDs. Values can be objects or "account:model:reasoning" strings. */
  routes: Record<string, CustomRouteValue>;
  /** Built-in model exposure settings. */
  defaults: {
    models: string[];
    reasoning: ReasoningEffort[];
  };
}

export interface ModelRoute {
  publicModelId: string;
  account: Account;
  codexModel: string;
  reasoning: ReasoningEffort;
  source: "account-name" | "custom";
}

export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: "function";
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface ChatCompletionRequest {
  model: string;
  messages?: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
      strict?: boolean;
    };
  }>;
  tool_choice?: unknown;
  [key: string]: unknown;
}
