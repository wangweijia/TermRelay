import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolEventKind, ToolEventPayload, ToolEventCorrelation } from '@termrelay/contracts';
import { JsonLineClient, RpcRejected, UnknownResultError } from './rpc.js';
import { VERSION, integer, record, text, type JsonObject } from './util.js';
import { validateToolEvent } from './validation.js';

export interface RpcConnection {
  start(): Promise<void>;
  request(method: string, params: JsonObject, timeout?: number): Promise<unknown>;
  notify(method: string, params: JsonObject): Promise<void>;
  respond(id: string | number, result: unknown): Promise<void>;
  respondError(id: string | number, code: number, message: string): Promise<void>;
  close(): Promise<void>;
}
export type RpcFactory = (argv: string[], cwd: string, receive: (value: JsonObject) => Promise<void>, fail: (message: string) => void) => RpcConnection;
interface Model { id: string; name: string; isDefault: boolean; defaultEffort?: string; efforts: string[] }
interface Approval { rpcId: string | number; turnId: string; itemId: string; results: Map<string, unknown> }
interface Question { rpcId: string | number; turnId: string; itemId: string; ids: string[]; deadline?: number }
export interface AgentRuntime {
  start(): Promise<void>;
  publishConfiguration(): void;
  command(kind: string, payload: JsonObject, commandId: string): Promise<void>;
  setAutoApprove(enabled: boolean): Promise<void>;
  close(): Promise<void>;
}

export class CodexRuntime implements AgentRuntime {
  readonly client: RpcConnection;
  threadId?: string; turnId?: string; busy = false;
  readonly approvals = new Map<string, Approval>();
  readonly questions = new Map<string, Question>();
  private readonly completedTurns = new Set<string>();
  private readonly models = new Map<string, Model>();
  private selectedModel?: string;
  private selectedEffort?: string;
  private autoApprove = false;
  private closing?: Promise<void>;
  constructor(
    executable: string, readonly directory: string, private readonly output: (payload: ToolEventPayload) => void,
    factory: RpcFactory = (argv, cwd, receive, fail) => new JsonLineClient(argv, cwd, receive, fail),
  ) {
    this.client = factory([executable, 'app-server'], directory, value => this.receive(value),
      message => { if (!this.closing) this.emit('error', { code: 'runtime_exited', message }, this.turnId); });
  }
  emit(kind: ToolEventKind, data: JsonObject, turnId?: string, itemId?: string, approvalId?: string): void {
    const correlation: ToolEventCorrelation = {};
    if (turnId !== undefined) correlation.turnId = text(turnId);
    if (itemId !== undefined) correlation.itemId = text(itemId);
    if (approvalId !== undefined) correlation.approvalId = text(approvalId);
    const payload: ToolEventPayload = { kind, occurredAt: new Date().toISOString(), correlation, data };
    validateToolEvent(payload); this.output(payload);
  }
  async start(): Promise<void> {
    await this.client.start();
    record(await this.client.request('initialize', {
      clientInfo: { name: 'termrelay', title: 'TermRelay Linux', version: VERSION },
      capabilities: { experimentalApi: false },
    }));
    await this.client.notify('initialized', {});
    const result = record(await this.client.request('thread/start', {
      cwd: this.directory, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      sandbox: 'workspace-write', ephemeral: true, serviceName: 'termrelay',
    }));
    this.threadId = text(record(result.thread).id);
    const models = record(await this.client.request('model/list', {})).data;
    if (!Array.isArray(models) || models.length > 1000) throw new Error('Invalid Codex model list');
    for (const value of models) {
      const model = record(value);
      if (model.hidden === true) continue;
      const id = text(model.id, 128);
      const efforts = model.supportedReasoningEfforts ?? [];
      if (!Array.isArray(efforts) || efforts.length > 200) throw new Error('Invalid reasoning effort list');
      this.models.set(id, {
        id, name: model.displayName === undefined ? id : text(model.displayName, 128, 0),
        isDefault: model.isDefault === true,
        ...(model.defaultReasoningEffort == null ? {} : { defaultEffort: text(model.defaultReasoningEffort, 128) }),
        efforts: efforts.map(value => text(record(value).reasoningEffort, 128)),
      });
    }
    if (this.models.size > 200) throw new Error('Too many Codex models');
    this.selectedModel = [...this.models.values()].find(model => model.isDefault)?.id ?? this.models.keys().next().value;
    this.selectEffort();
  }
  private selectEffort(): void {
    const model = this.selectedModel ? this.models.get(this.selectedModel) : undefined;
    this.selectedEffort = model?.defaultEffort && model.efforts.includes(model.defaultEffort)
      ? model.defaultEffort : model?.efforts[0];
  }
  configuration(): JsonObject[] {
    if (!this.selectedModel) return [];
    const options: JsonObject[] = [{
      id: 'model', name: 'Model', currentValue: this.selectedModel,
      choices: [...this.models.values()].map(model => ({ value: model.id, name: model.name })),
    }];
    const model = this.models.get(this.selectedModel)!;
    if (this.selectedEffort) options.push({
      id: 'effort', name: 'Reasoning effort', currentValue: this.selectedEffort,
      choices: model.efforts.map(value => ({ value, name: value })),
    });
    return options;
  }
  publishConfiguration(): void { this.emit('config.updated', { options: this.configuration() }); }
  async command(kind: string, payload: JsonObject, commandId: string): Promise<void> {
    if (this.closing || !this.threadId) throw new Error('Codex session is not ready');
    switch (kind) {
      case 'tool.turn.start': {
        const message = text(payload.text, 65536);
        if (!message.trim() || this.busy) throw new Error('Empty prompt or a turn is already running');
        this.busy = true;
        this.emit('user.message', { messageId: commandId, text: message }, undefined, commandId);
        let result: JsonObject;
        try {
          result = record(await this.client.request('turn/start', {
            threadId: this.threadId, clientUserMessageId: commandId, input: [{ type: 'text', text: message }],
            ...(this.selectedModel ? { model: this.selectedModel } : {}),
            ...(this.selectedEffort ? { effort: this.selectedEffort } : {}),
          }));
        } catch (error) {
          if (error instanceof RpcRejected) this.busy = false;
          throw error;
        }
        let turn: string;
        try { turn = text(record(result.turn).id); }
        catch { throw new UnknownResultError('turn/start returned no valid turn ID; execution result unknown'); }
        if (this.completedTurns.has(turn)) this.busy = false;
        else if (this.turnId !== turn) {
          this.turnId = turn; this.emit('turn.started', { turnId: turn }, turn);
        }
        return;
      }
      case 'tool.turn.interrupt':
        if (!this.turnId) throw new Error('No active turn');
        await this.client.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); return;
      case 'tool.config.set': {
        const id = text(payload.id), value = text(payload.value, 128);
        if (id === 'model' && this.models.has(value)) { this.selectedModel = value; this.selectEffort(); }
        else if (id === 'effort' && this.selectedModel && this.models.get(this.selectedModel)?.efforts.includes(value)) this.selectedEffort = value;
        else throw new Error('Unadvertised Codex configuration choice');
        this.publishConfiguration(); return;
      }
      case 'tool.approval.resolve': {
        const id = text(payload.approvalId), decision = text(payload.decision);
        const approval = this.approvals.get(id);
        if (!approval || approval.turnId !== payload.turnId || !approval.results.has(decision)) throw new Error('Approval expired or invalid decision');
        this.approvals.delete(id);
        await this.client.respond(approval.rpcId, approval.results.get(decision));
        this.emit('approval.resolved', { approvalId: id, turnId: approval.turnId, decision }, approval.turnId, approval.itemId, id);
        return;
      }
      case 'tool.user-input.resolve': {
        const id = text(payload.requestId), pending = this.questions.get(id);
        if (!pending || pending.turnId !== payload.turnId) throw new Error('Question expired or belongs to another turn');
        if (pending.deadline !== undefined && performance.now() >= pending.deadline) {
          this.questions.delete(id); throw new Error('Question expired');
        }
        const answers = record(payload.answers);
        if (Object.keys(answers).length !== pending.ids.length || pending.ids.some(key => !Object.hasOwn(answers, key))) throw new Error('Answers must cover every question');
        const response = Object.fromEntries(Object.entries(answers).map(([key, values]) => {
          if (!Array.isArray(values) || !values.length) throw new Error('Invalid answer');
          return [key, { answers: values.map(value => text(value, 65536, 0)) }];
        }));
        this.questions.delete(id);
        await this.client.respond(pending.rpcId, { answers: response });
        this.emit('user-input.resolved', { requestId: id, turnId: pending.turnId, answers }, pending.turnId, pending.itemId);
        return;
      }
      default: throw new Error('Unsupported Codex command');
    }
  }
  async receive(message: JsonObject): Promise<void> {
    const method = text(message.method), params = record(message.params ?? {});
    if ('id' in message) {
      const id = message.id;
      if (typeof id !== 'string' && (typeof id !== 'number' || !Number.isSafeInteger(id))) throw new Error('Invalid provider request ID');
      await this.receiveRequest(id, method, params); return;
    }
    if (this.threadId && params.threadId !== undefined && params.threadId !== this.threadId) throw new Error('Event belongs to another thread');
    const turnId = params.turnId === undefined ? undefined : text(params.turnId);
    const itemId = params.itemId === undefined ? undefined : text(params.itemId);
    switch (method) {
      case 'turn/started': {
        const id = text(record(params.turn).id);
        this.busy = true;
        if (this.turnId !== id) { this.turnId = id; this.emit('turn.started', { turnId: id }, id); }
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        this.emit(method === 'item/agentMessage/delta' ? 'assistant.delta' : method === 'item/plan/delta' ? 'plan.updated' : 'reasoning.delta',
          { text: text(params.delta, 1048576, 0) }, turnId, itemId); break;
      case 'turn/plan/updated': {
        if (!Array.isArray(params.plan)) throw new Error('Invalid plan');
        this.emit('plan.updated', { text: params.plan.map(step => text(record(step).step ?? record(step).text, 65536, 0)).join('\n') }, turnId); break;
      }
      case 'item/commandExecution/outputDelta':
        this.emit('command.output', { commandId: text(itemId), text: text(params.delta, 1048576, 0) }, turnId, itemId); break;
      case 'item/started':
      case 'item/completed': {
        const item = record(params.item), id = text(item.id);
        if (item.type === 'commandExecution') {
          if (method === 'item/started') this.emit('command.started', { commandId: id, command: text(item.command, 65536) }, turnId, id);
          else {
            const code = item.exitCode == null ? null : integer(item.exitCode, -2147483648, 2147483647);
            this.emit('command.completed', { commandId: id, exitCode: code }, turnId, id);
          }
        } else if (method === 'item/completed' && item.type === 'agentMessage') {
          this.emit('assistant.completed', { text: text(item.text ?? '', 1048576, 0) }, turnId, id);
        } else if (method === 'item/completed' && item.type === 'fileChange') {
          if (!Array.isArray(item.changes)) throw new Error('Invalid file changes');
          this.emit('file.changed', { itemId: id, summary: `${item.changes.length} file changes` }, turnId, id);
        }
        break;
      }
      case 'turn/completed': {
        const turn = record(params.turn), id = text(turn.id);
        const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
        this.emit('turn.completed', { turnId: id, status }, id);
        this.completedTurns.add(id);
        if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.values().next().value!);
        if (this.turnId === id) { this.turnId = undefined; this.busy = false; }
        for (const [key, pending] of this.approvals) if (pending.turnId === id) this.approvals.delete(key);
        for (const [key, pending] of this.questions) if (pending.turnId === id) this.questions.delete(key);
        break;
      }
      case 'error': this.emit('warning', { code: 'codex_turn_error', message: 'Codex reported a turn error; awaiting final state' }, turnId ?? this.turnId); break;
    }
  }
  private async receiveRequest(id: string | number, method: string, params: JsonObject): Promise<void> {
    if (this.approvals.size + this.questions.size >= 128) throw new Error('Too many pending interactions');
    if (!this.turnId || params.turnId !== this.turnId || (params.threadId !== undefined && params.threadId !== this.threadId)) {
      await this.client.respondError(id, -32602, 'Invalid request correlation'); return;
    }
    const turnId = this.turnId, itemId = text(params.itemId);
    if (method === 'item/tool/requestUserInput') {
      if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 16) throw new Error('Invalid questions');
      const questions = params.questions.map(input => {
        const q = record(input), options = q.options ?? [];
        if (!Array.isArray(options)) throw new Error('Invalid question options');
        const allowsOther = q.isOther === undefined ? !options.length : q.isOther;
        const isSecret = q.isSecret === undefined ? false : q.isSecret;
        if (typeof allowsOther !== 'boolean' || typeof isSecret !== 'boolean') throw new Error('Invalid question metadata');
        return {
          id: text(q.id), header: text(q.header, 256, 0), question: text(q.question, 65536, 0),
          options: options.map(input => { const o = record(input); return { label: text(o.label, 65536, 0), description: text(o.description ?? '', 65536, 0) }; }),
          allowsOther, isSecret,
        };
      });
      const ids = questions.map(q => q.id);
      const blocking = params.isBlocking === undefined ? true : params.isBlocking;
      if (new Set(ids).size !== ids.length || typeof blocking !== 'boolean') throw new Error('Invalid question IDs / blocking state');
      const timeout = params.autoResolutionMs === undefined ? undefined : integer(params.autoResolutionMs, 1, 86400000);
      const requestId = randomUUID();
      this.questions.set(requestId, { rpcId: id, turnId, itemId, ids, ...(timeout ? { deadline: performance.now() + timeout } : {}) });
      this.emit('user-input.requested', {
        requestId, turnId, itemId, questions, isBlocking: blocking,
        ...(timeout ? { expiresAt: new Date(Date.now() + timeout).toISOString() } : {}),
      }, turnId, itemId);
      return;
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
      await this.client.respondError(id, -32601, 'Unsupported request'); return;
    }
    const kind = method.includes('/permissions/') ? 'permissions' : method.includes('/fileChange/') ? 'fileChange' : 'command';
    const results = new Map<string, unknown>();
    if (kind === 'permissions') {
      const permissions = record(params.permissions);
      results.set('allowOnce', { permissions, scope: 'turn' });
      results.set('allowSession', { permissions, scope: 'session' });
      results.set('deny', { permissions: {}, scope: 'turn' }); results.set('cancel', { permissions: {}, scope: 'turn' });
    } else {
      const mapping: Record<string, string> = { accept: 'allowOnce', acceptForSession: 'allowSession', decline: 'deny', cancel: 'cancel' };
      const available = params.availableDecisions ?? Object.keys(mapping);
      if (!Array.isArray(available)) throw new Error('Invalid approval decisions');
      for (const decision of available) {
        if (typeof decision === 'string' && Object.hasOwn(mapping, decision)) results.set(mapping[decision]!, { decision });
      }
      if (kind === 'command' && Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length) {
        results.set('allowPolicy', { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } } });
      } else if (kind === 'command' && Array.isArray(params.proposedNetworkPolicyAmendments) && params.proposedNetworkPolicyAmendments.length) {
        results.set('allowPolicy', { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: params.proposedNetworkPolicyAmendments[0] } } });
      }
    }
    if (!results.size) { await this.client.respondError(id, -32602, 'No supported decision'); return; }
    const approvalId = randomUUID();
    this.approvals.set(approvalId, { rpcId: id, turnId, itemId, results });
    this.emit('approval.requested', {
      approvalId, turnId, itemId, kind, risk: kind === 'command' ? 'medium' : 'high',
      title: kind === 'command' ? 'Approve command' : kind === 'fileChange' ? 'Approve file changes' : 'Approve additional permissions',
      detail: text(params.command ?? params.reason ?? '', 65536, 0),
      availableDecisions: [...results.keys()], expiresAt: '9999-12-31T23:59:59.000Z',
    }, turnId, itemId, approvalId);
    if (this.autoApprove) await this.approvePending();
  }
  async setAutoApprove(enabled: boolean): Promise<void> {
    this.autoApprove = enabled;
    if (enabled) await this.approvePending();
  }
  private async approvePending(): Promise<void> {
    for (const [id, pending] of [...this.approvals]) {
      if (!this.autoApprove || !this.approvals.has(id)) continue;
      const decision = ['allowOnce', 'allowSession', 'allowPolicy'].find(value => pending.results.has(value));
      if (!decision) throw new Error('automatic_approval_failed: no supported allow decision');
      await this.command('tool.approval.resolve', { approvalId: id, turnId: pending.turnId, decision }, randomUUID());
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.approvals.clear(); this.questions.clear();
      this.closing = Promise.resolve().then(() => this.client.close());
    }
    return this.closing;
  }
}
