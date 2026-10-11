import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AIRepository } from './ai.repository';
import { AIProjectKeyEntity } from './ai.entity';

export const keySummary = ({id,projectId,grants,revoked}: AIProjectKeyEntity) => ({id,projectId,grants,revoked});

@Injectable()
export class AISettingsService {
  constructor(private readonly repo: AIRepository) {}

  list() { return this.repo.keyTransaction(keys => [...keys.values()].map(keySummary)); }

  create(body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('invalid_key_settings');
    const b = body as Record<string,unknown>;
    if (Object.keys(b).some(k => !['projectId','deviceIds','profiles','capacity'].includes(k))
      || typeof b.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(b.projectId)
      || !Array.isArray(b.deviceIds) || b.deviceIds.length < 1 || b.deviceIds.length > 8
      || !b.deviceIds.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
      || !Array.isArray(b.profiles) || b.profiles.length < 1 || b.profiles.length > 32
      || !b.profiles.every(id => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(id))
      || typeof b.capacity !== 'number' || !Number.isInteger(b.capacity) || b.capacity < 1 || b.capacity > 16) throw new BadRequestException('invalid_key_settings');
    const projectId = b.projectId;
    const grants = {deviceIds:[...new Set((b.deviceIds as string[]).map(id => id.toLowerCase()))].sort(),
      profiles:[...new Set(b.profiles as string[])].sort(),capacity:b.capacity};
    return this.repo.keyTransaction(keys => {
      const existing = [...keys.values()].find(k => k.projectId === projectId && !k.revoked);
      if (existing && (existing.grants.capacity !== grants.capacity
        || JSON.stringify([...existing.grants.deviceIds].sort()) !== JSON.stringify(grants.deviceIds)
        || JSON.stringify([...existing.grants.profiles].sort()) !== JSON.stringify(grants.profiles))) throw new ConflictException('project_grants_conflict');
      return this.generate(keys,projectId,grants);
    });
  }

  rotate(id: string) {
    return this.repo.keyTransaction(keys => {
      const key = keys.get(id);
      if (!key || key.revoked) throw new NotFoundException('key_not_found');
      return this.generate(keys,key.projectId,structuredClone(key.grants));
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

  private generate(keys: Map<string,AIProjectKeyEntity>, projectId: string, grants: AIProjectKeyEntity['grants']) {
    const apiKey = `trai_${randomBytes(32).toString('base64url')}`;
    const key = {id:randomUUID(),projectId,grants,revoked:false,keyHash:createHash('sha256').update(apiKey).digest('hex')};
    keys.set(key.id,key);
    return {...keySummary(key),apiKey};
  }
}
