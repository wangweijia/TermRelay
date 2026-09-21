import { Injectable } from '@nestjs/common';

interface RateBucket {
  count: number;
  resetsAt: number;
}

@Injectable()
export class ClientAuthRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly maxBuckets = 10_000;

  consume(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const existing = this.buckets.get(key);
    if (existing && existing.resetsAt > now) {
      if (existing.count >= limit) return false;
      existing.count += 1;
      return true;
    }

    if (this.buckets.size >= this.maxBuckets) this.removeExpired(now);
    if (this.buckets.size >= this.maxBuckets && !existing) return false;
    this.buckets.set(key, { count: 1, resetsAt: now + windowMs });
    return true;
  }

  private removeExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetsAt <= now) this.buckets.delete(key);
    }
  }
}

export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  fallback: string,
): string {
  const value = headers['cf-connecting-ip'];
  return (Array.isArray(value) ? value[0] : value) || fallback;
}