import {useState} from 'react';
import {Box, Text, render} from 'ink';
import TextInput from 'ink-text-input';

export type Respond = (message: string) => Promise<string>;

type TranscriptEntry = {
  role: 'user' | 'agent' | 'error';
  text: string;
};

type AppProps = {
  respond: Respond;
};

function App({respond}: AppProps) {
  const [input, setInput] = useState('');
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [isThinking, setIsThinking] = useState(false);

  async function submit(value: string) {
    const message = value.trim();

    if (!message || isThinking) {
      return;
    }

    setInput('');
    setTranscript(entries => [...entries, {role: 'user', text: message}]);
    setIsThinking(true);

    try {
      const response = await respond(message);
      setTranscript(entries => [...entries, {role: 'agent', text: response}]);
    } catch (error) {
      console.error('Agent response failed:', error);
      setTranscript(entries => [
        ...entries,
        {role: 'error', text: 'Something went wrong. Try again.'},
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Agent Harness</Text>
      </Box>

      {transcript.map((entry, index) => (
        <Box key={index}>
          <Text
            bold
            color={
              entry.role === 'user'
                ? 'cyan'
                : entry.role === 'agent'
                  ? 'green'
                  : 'red'
            }
          >
            {entry.role === 'user'
              ? 'You'
              : entry.role === 'agent'
                ? 'Agent'
                : 'Error'}
            :{' '}
          </Text>
          <Text color={entry.role === 'error' ? 'red' : undefined}>
            {entry.text}
          </Text>
        </Box>
      ))}

      <Box marginTop={1}>
        {isThinking ? (
          <Text color="cyan">Thinking…</Text>
        ) : (
          <Box borderStyle="round" borderColor="cyan" paddingX={1} flexGrow={1}>
            <Text color="cyan">› </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={value => void submit(value)}
            />
            {input.length === 0 && <Text> Type a message</Text>}
          </Box>
        )}
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
