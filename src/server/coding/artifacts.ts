import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { AppContext } from '../context.js';
import type { Row } from '../marketplace/data.js';

export function seal(ctx: AppContext, value: unknown) {
  const nonce = randomBytes(12),
    key = createHash('sha256')
      .update('wick-coding-v1\0' + ctx.config.authSecret)
      .digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [
    nonce.toString('base64'),
    body.toString('base64'),
    cipher.getAuthTag().toString('base64'),
  ].join('.');
}
export function open(ctx: AppContext, value: string): Row {
  const [nonce, body, tag] = value.split('.');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256')
      .update('wick-coding-v1\0' + ctx.config.authSecret)
      .digest(),
    Buffer.from(nonce!, 'base64'),
  );
  cipher.setAuthTag(Buffer.from(tag!, 'base64'));
  return JSON.parse(
    Buffer.concat([cipher.update(Buffer.from(body!, 'base64')), cipher.final()]).toString('utf8'),
  );
}
