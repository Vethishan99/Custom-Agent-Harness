import { useEffect, useRef, useState } from "react";
import { Box, Static, Text, render, useStdout } from "ink";
import TextInput from "ink-text-input";
import type { AgentHooks } from "../types.ts";
import {
  closeOpenMarkers,
  type Line,
  LineSplitter,
  MarkdownLine,
} from "./markdown.tsx";
import { Typewriter } from "./typewriter.ts";

// Let the TUI pass interface hooks into the harness boundary.
export type Respond = (message: string, hooks: AgentHooks) => Promise<string>;

// Represent approval requests alongside the existing transcript roles.
// Agent replies are stored one Markdown line per entry.
type TranscriptEntry =
  | { role: "user" | "event" | "approval" | "error"; text: string }
  | ({ role: "agent" } & Line);

// Width of "Agent: ", so every line of a reply starts in the same column.
const LABEL_WIDTH = 7;

type PendingApproval = {
  action: string;
  resolve: (approved: boolean) => void;
};

// Session details shown once at the top of the screen.
export type SessionInfo = {
  projectRoot: string;
  branch: string | null;
  provider: string;
  model: string;
  shell: boolean;
};

type AppProps = {
  respond: Respond;
  info: SessionInfo;
};

function labelFor(role: TranscriptEntry["role"]): string {
  if (role === "user") return "You";
  if (role === "agent") return "Agent";
  if (role === "event") return "Tool";
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

// "Thinking." → "Thinking.." → "Thinking..." on a loop, so it's clear the
// agent is still working. The dots are padded so the line never shifts.
function Working({ label }: { label: string }) {
  const [dots, setDots] = useState(1);
  useEffect(() => {
    const timer = setInterval(() => setDots((count) => (count % 3) + 1), 400);
    return () => clearInterval(timer);
  }, []);
  return (
    <Text color="yellow">
      {label}
      {".".repeat(dots).padEnd(3)}
    </Text>
  );
}

// One line of a reply, in a column beside the "Agent:" label. The explicit
// width keeps finished lines wrapping exactly like the line being typed.
function AgentLine({ line }: { line: Line }) {
  const { stdout } = useStdout();
  const columns = stdout.columns || 80;
  return (
    <Box paddingX={2} width={columns} marginTop={line.gap ? 1 : 0}>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        {line.first ? (
          <Text bold color={colorFor("agent")}>
            {labelFor("agent")}:
          </Text>
        ) : null}
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <MarkdownLine
          text={line.text}
          code={line.code}
          width={columns - 4 - LABEL_WIDTH}
        />
      </Box>
    </Box>
  );
}

function App({ respond, info }: AppProps) {
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  // The reply line still being typed; finished lines go to the transcript.
  const [live, setLive] = useState<Line | null>(null);
  const splitter = useRef(new LineSplitter());
  const typewriter = useRef<Typewriter | null>(null);
  typewriter.current ??= new Typewriter(reveal);

  function append(entry: TranscriptEntry) {
    setTranscript((entries) => [...entries, entry]);
  }

  // Called by the typewriter with the next few characters of the reply.
  function reveal(text: string) {
    for (const line of splitter.current.push(text)) {
      append({ role: "agent", ...line });
    }
    setLive(splitter.current.current());
  }

  // Move the rest of the reply into the transcript before other output.
  function endReply() {
    for (const line of splitter.current.end()) {
      append({ role: "agent", ...line });
    }
    setLive(null);
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

    // Events and approvals wait for the text before them to finish typing.
    const writer = typewriter.current!;
    let streamed = false;
    const hooks: AgentHooks = {
      emit(text) {
        writer.then(() => {
          endReply();
          append({ role: "event", text });
        });
      },
      stream(text) {
        if (text.trim()) streamed = true;
        writer.write(text);
      },
      approve(action) {
        return new Promise<boolean>((resolveApproval) => {
          writer.then(() => {
            endReply();
            setApproval({ action, resolve: resolveApproval });
          });
        });
      },
    };

    let failure: string | null = null;
    try {
      const response = await respond(message, hooks);
      // The reply usually arrived as a stream; type it out here if not.
      if (!streamed) writer.write(response);
    } catch (error) {
      failure = error instanceof Error ? error.message : "Something went wrong.";
    }

    await writer.idle();
    endReply();
    if (failure) append({ role: "error", text: failure });
    setIsThinking(false);
  }

  return (
    <>
      {/* Static prints each entry once, so typing doesn't redraw history.
          Ink requires it at the top level, outside any padded Box. */}
      <Static items={[null, ...transcript]}>
        {(entry, index) =>
          entry === null ? (
            <Box
              key="header"
              flexDirection="column"
              marginBottom={1}
              paddingX={2}
              paddingTop={1}
            >
              <Text bold>Agent Harness</Text>
              <Text dimColor>
                Project: {info.projectRoot}
                {info.branch ? ` (${info.branch})` : ""}
              </Text>
              <Text dimColor>
                Model: {info.provider} / {info.model}
              </Text>
              {info.shell ? (
                <Text color="yellow">
                  Shell commands run with your full user permissions. Read
                  each one before approving.
                </Text>
              ) : (
                <Text dimColor>Shell commands are disabled.</Text>
              )}
            </Box>
          ) : entry.role === "agent" ? (
            <AgentLine key={index} line={entry} />
          ) : (
            <Box key={index} paddingX={2}>
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

      {/* The line of the reply that is still being typed. */}
      {live ? (
        <AgentLine
          line={live.code ? live : { ...live, text: closeOpenMarkers(live.text) }}
        />
      ) : null}

      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        {/* Show the pending action before collecting its decision. */}
        {approval ? (
          <Text color="magenta">
            Approve "{approval.action}"? Type y to approve. Any other response
            denies.
          </Text>
        ) : null}

        <Box>
          {isThinking && !approval ? (
            <Working label={live ? "Writing" : "Thinking"} />
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

      <Box marginTop={1} paddingX={2} paddingBottom={1}>
        <Text>
          <Text color="cyan">Ctrl+C</Text> to exit
        </Text>
      </Box>
    </>
  );
}

export function runTui(respond: Respond, info: SessionInfo): void {
  render(<App respond={respond} info={info} />);
}
