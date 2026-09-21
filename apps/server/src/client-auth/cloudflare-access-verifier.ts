import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface CloudflareAccessIdentity {
  subject: string;
  email: string | null;
}

@Injectable()
export class CloudflareAccessVerifier {
  private readonly issuer: string | undefined;
  private readonly audience: string | undefined;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor() {
    const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN?.trim();
    this.audience = process.env.CF_ACCESS_AUD?.trim();
    if (teamDomain) {
      this.issuer = teamDomain.startsWith('https://')
        ? teamDomain.replace(/\/$/, '')
        : `https://${teamDomain.replace(/\/$/, '')}`;
      this.jwks = createRemoteJWKSet(new URL(`${this.issuer}/cdn-cgi/access/certs`));
    }
  }

  async verify(assertion: string | undefined): Promise<CloudflareAccessIdentity> {
    if (!this.issuer || !this.audience || !this.jwks) {
      throw new ServiceUnavailableException('Cloudflare Access verification is not configured');
    }
    if (!assertion || assertion.length > 16_384) {
      throw new UnauthorizedException('Cloudflare Access identity is required');
    }
    try {
      const { payload } = await jwtVerify(assertion, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      });
      if (!payload.sub) throw new Error('missing subject');
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : null,
      };
    } catch {
      throw new UnauthorizedException('Cloudflare Access identity is invalid');
    }
  }
}