# Agent Harness TUI

A minimal TypeScript and Ink starter for connecting an agent to a terminal interface.

## Requirements

- Node.js 18 or newer

## Install

```sh
npm install
```

## Configure

Copy the example environment file and add your OpenRouter API key:

```sh
cp .env.example .env
```

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

## Run

```sh
npm run dev
```

Edit the asynchronous `respond` function in `src/index.ts` to connect your own agent. The terminal UI lives in `src/tui/`.

To compile and run the built project:

```sh
npm run build
npm start
```
