import 'dotenv/config';

import {runTui} from './tui/index.js';

async function respond(message: string): Promise<string> {
  await new Promise(resolve => setTimeout(resolve, 500));
  return `You said: ${message}`;
}

runTui(respond);
