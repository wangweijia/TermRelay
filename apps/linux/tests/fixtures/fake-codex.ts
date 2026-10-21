import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { record } from '../../src/util.js';

function send(value: unknown): void { process.stdout.write(JSON.stringify(value) + '\n'); }
createInterface({ input: process.stdin }).on('line', line => {
  const message = record(JSON.parse(line));
  let result: unknown = {};
  switch (message.method) {
    case 'initialize': result = { serverInfo: { name: 'synthetic' } }; break;
    case 'thread/start': result = { thread: { id: 'thread' } }; break;
    case 'model/list': result = { data: [{
      id: 'synthetic', displayName: 'Synthetic', isDefault: true,
      defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
    }] }; break;
    case 'turn/start':
      send({ id: message.id, result: { turn: { id: 'turn' } } });
      send({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'answer', delta: 'synthetic answer 中文' } });
      send({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'synthetic answer 中文' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
      return;
    case 'test/no-response': return;
    case 'test/malformed': process.stdout.write('not-json\n'); return;
    case 'test/echo': result = message.params; break;
    case 'test/error': send({ id: message.id, error: { code: -1, message: 'synthetic sensitive body' } }); return;
    case 'test/fork': {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
      child.unref(); result = { pid: child.pid }; break;
    }
    default: if (!message.method || message.id === undefined) return;
  }
  send({ id: message.id, result });
});
