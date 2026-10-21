import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AIRepository } from './ai.repository';
import { AIProjectKeyEntity } from './ai.entity';

const keySummary = ({id,revoked,grants}: AIProjectKeyEntity) => ({id,revoked,legacy:grants.unrestricted !== true});

@Injectable()
export class AISettingsService {
  constructor(private readonly repo: AIRepository) {}

  list() { return this.repo.keyTransaction(keys => [...keys.values()].map(keySummary)); }

  create(body?: unknown) {
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length))
      throw new BadRequestException('invalid_key_settings');
    return this.repo.keyTransaction(keys => this.generate(keys));
  }

  rotate(id: string) {
    return this.repo.keyTransaction(keys => {
      const key = keys.get(id);
      if (!key || key.revoked) throw new NotFoundException('key_not_found');
      return this.generate(keys);
    });
  }

  revoke(id: string) {
    return this.repo.keyTransaction(keys => {
      const key = keys.get(id);
      if (!key) throw new NotFoundException('key_not_found');
      key.revoked = true;
      return keySummary(key);
    });
  }

  private generate(keys: Map<string,AIProjectKeyEntity>) {
    const apiKey = `trai_${randomBytes(32).toString('base64url')}`;
    // Shared internal namespace, not a caller's project identity. No per-key routing or permissions.
    const key = {id:randomUUID(),projectId:'api',grants:{unrestricted:true},revoked:false,keyHash:createHash('sha256').update(apiKey).digest('hex')};
    keys.set(key.id,key);
    return {...keySummary(key),apiKey};
  }
}
