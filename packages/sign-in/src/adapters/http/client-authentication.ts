/** A registered console or gateway client authenticates by HTTP Basic or by form credentials, never both trusted at once. */
import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ServiceConfig } from '../../config.js';

const BASIC_PREFIX = 'Basic ';
const FIELD_LIMIT = 4096;
const formCredentialsSchema = z.object({ client_id: z.string().min(1).max(FIELD_LIMIT), client_secret: z.string().min(1).max(FIELD_LIMIT) });

/** The registered client that authenticated, or null. */
export function clientOf(request: FastifyRequest, config: ServiceConfig): ServiceConfig['clients'][number] | null {
  const claimed = request.headers.authorization?.startsWith(BASIC_PREFIX) === true ? basicOf(request.headers.authorization) : formOf(request.body);
  if (claimed === null) return null;
  const client = config.clients.find((candidate) => candidate.id === claimed.id);
  if (client === undefined) return null;
  return timingSafeEqual(createHash('sha256').update(client.secret).digest(), createHash('sha256').update(claimed.secret).digest()) ? client : null;
}

function basicOf(authorization: string): { id: string; secret: string } | null {
  const decoded = Buffer.from(authorization.slice(BASIC_PREFIX.length), 'base64').toString();
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  try { return { id: decodeURIComponent(decoded.slice(0, separator)), secret: decodeURIComponent(decoded.slice(separator + 1)) }; }
  catch { return null; }
}

function formOf(body: unknown): { id: string; secret: string } | null {
  const parsed = formCredentialsSchema.safeParse(body);
  return parsed.success ? { id: parsed.data.client_id, secret: parsed.data.client_secret } : null;
}
