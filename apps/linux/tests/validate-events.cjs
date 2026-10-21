const { readFileSync } = require('node:fs');
const { ProtocolValidator } = require('../../server/dist/realtime/protocol-validator.js');

const packets = JSON.parse(readFileSync(0, 'utf8'));
const validator = new ProtocolValidator();
const kinds = new Set();
for (const packet of packets) {
  const result = validator.validate(packet.data);
  if (!result.ok) {
    throw new Error(`${packet.data.type}: ${JSON.stringify(result)}`);
  }
  if (packet.data.type === 'tool.event') kinds.add(packet.data.payload.kind);
}
for (const kind of [
  'config.updated', 'user.message', 'turn.started', 'assistant.delta', 'assistant.completed',
  'reasoning.delta', 'plan.updated', 'command.started', 'command.output', 'command.completed',
  'file.changed', 'approval.requested', 'approval.resolved', 'user-input.requested',
  'user-input.resolved', 'turn.completed', 'warning', 'error',
]) {
  if (!kinds.has(kind)) throw new Error(`Missing synthetic event: ${kind}`);
}
console.log(`Validated ${packets.length} Linux packets and ${kinds.size} tool event kinds.`);
