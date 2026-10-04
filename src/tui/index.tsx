import { useState } from "react";
import { Box, Static, Text, render } from "ink";
import TextInput from "ink-text-input";
import type { AgentHooks } from "../types.ts";

// Let the TUI pass interface hooks into the harness boundary.
export type Respond = (message: string, hooks: AgentHooks) => Promise<string>;

// Represent approval requests alongside the existing transcript roles.
type TranscriptEntry = {
  role: "user" | "agent" | "event" | "approval" | "error";
  text: string;
};

type PendingApproval = {
  action: string;
  resolve: (approved: boolean) => void;
};

type AppProps = {
  respond: Respond;
};

function labelFor(role: TranscriptEntry["role"]): string {
  if (role === "user") return "You";
  if (role === "agent") return "Agent";
  if (role === "event") return "Event";
  if (role === "approval") return "Approval";
  return "Error";
}

function colorFor(role: TranscriptEntry["role"]): string {
  if (role === "user") return "cyan";
  if (role === "agent") return "green";
  if (role === "event") return "yellow";
  if (role === "approval") return "magenta";
  return "red";
}

function App({ respond }: AppProps) {
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);

  function append(entry: TranscriptEntry) {
    setTranscript((entries) => [...entries, entry]);
  }

  function settleApproval(message: string): boolean {
    if (!approval) return false;

    // Record the decision before releasing the waiting executor.
    const pending = approval;
    const approved = /^y(es)?$/i.test(message);
    setInput("");
    setApproval(null);
    append({
      role: "approval",
      text: `${approved ? "Approved" : "Denied"}: ${pending.action}`,
    });
    pending.resolve(approved);
    return true;
  }

  async function submit(value: string) {
    const message = value.trim();

    // Route input to a pending approval before accepting a new task.
    if (settleApproval(message)) {
      return;
    }

    if (!message || isThinking) {
      return;
    }

    setInput("");
    append({ role: "user", text: message });
    setIsThinking(true);

    // Translate runtime events and approvals into TUI state.
    const hooks: AgentHooks = {
      emit(text) {
        append({ role: "event", text });
      },
      approve(action) {
        return new Promise<boolean>((resolveApproval) => {
          setApproval({ action, resolve: resolveApproval });
        });
      },
    };

    try {
      const response = await respond(message, hooks);
      append({ role: "agent", text: response });
    } catch (error) {
      append({
        role: "error",
        text: error instanceof Error ? error.message : "Something went wrong.",
      });
    } finally {
      setIsThinking(false);
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Static prints each entry once, so typing doesn't redraw history. */}
      <Static items={[null, ...transcript]}>
        {(entry, index) =>
          entry === null ? (
            <Box key="header" marginBottom={1} paddingX={1} paddingTop={1}>
              <Text bold>Agent Harness</Text>
            </Box>
          ) : (
            <Box key={index} paddingX={1}>
              <Text bold color={colorFor(entry.role)}>
                {labelFor(entry.role)}:{" "}
              </Text>
              <Text color={entry.role === "error" ? "red" : undefined}>
                {entry.text}
              </Text>
            </Box>
          )
        }
      </Static>

      <Box flexDirection="column">
        {/* Show the pending action before collecting its decision. */}
        {approval ? (
          <Text color="magenta">
            Approve "{approval.action}"? Type y to approve. Any other response
            denies.
          </Text>
        ) : null}

        <Box>
          {isThinking && !approval ? (
            <Text color="yellow">Thinking...</Text>
          ) : (
            <>
              <Text color="cyan">{approval ? "Approve> " : "> "}</Text>
              <TextInput
                value={input}
                onChange={setInput}
                onSubmit={(value) => {
                  void submit(value);
                }}
                placeholder={approval ? "y/N" : "Type a message"}
                focus={!isThinking || approval !== null}
              />
            </>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text>
          <Text color="cyan">Ctrl+C</Text> to exit
        </Text>
      </Box>
    </Box>
  );
}

export function runTui(respond: Respond): void {
  render(<App respond={respond} />);
}
