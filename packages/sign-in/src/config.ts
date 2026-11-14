/** Exact HTTPS sibling registration is validated before the service opens its database. */
import { idSchema } from '@aeolus-fleet/common';
import { z } from 'zod';

const httpsUrl = z.url().refine((value) => new URL(value).protocol === 'https:', 'HTTPS is required');
const clientSchema = z.object({ id: z.string().min(1), secret: z.string().min(1), redirectUri: httpsUrl });
const fleetSchema = z.object({ id: idSchema('fleet'), name: z.string().min(1), consoleUrl: httpsUrl, gatewayUrl: httpsUrl });

export const serviceConfigSchema = z.object({ origin: httpsUrl, cookieDomain: z.string().min(1), trustedProxy: z.string().min(1).optional(), clients: z.array(clientSchema).min(1), fleets: z.array(fleetSchema).min(1) }).superRefine((config, context) => {
  const origin = new URL(config.origin);
  const domain = config.cookieDomain;
  const siblings = [origin, ...config.clients.map((client) => new URL(client.redirectUri)), ...config.fleets.flatMap((fleet) => [new URL(fleet.consoleUrl), new URL(fleet.gatewayUrl)])];
  if (origin.origin !== config.origin || domain.startsWith('.') || !domain.includes('.') || siblings.some((url) => !url.hostname.endsWith(`.${domain}`) || url.username !== '' || url.password !== '' || url.hash !== '')) context.addIssue({ code: 'custom', message: 'Use HTTPS sibling hosts under one trusted parent cookie domain' });
  if (new Set(config.clients.map((client) => client.id)).size !== config.clients.length || new Set(config.fleets.map((fleet) => fleet.id)).size !== config.fleets.length) context.addIssue({ code: 'custom', message: 'Duplicate client or fleet registration' });
});

export type ServiceConfig = z.infer<typeof serviceConfigSchema>;

export function readConfig(environment: Readonly<Record<string, string | undefined>>) {
  const parsed = z.object({
    DATABASE_URL: z.string().min(1), SIGN_IN_ORIGIN: httpsUrl, SIGN_IN_COOKIE_DOMAIN: z.string().min(1),
    SIGN_IN_CLIENTS: z.string(), SIGN_IN_FLEETS: z.string(), SIGN_IN_SIGNING_KEYS: z.string(), SIGN_IN_ACTIVE_KEY_ID: z.string().min(1),
    SIGN_IN_TRUSTED_PROXY: z.string().min(1).optional(), CORE_URL: z.url(), INSTALLATION_TOKEN: z.string().min(1), PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  }).parse(environment);
  const json = (value: string): unknown => JSON.parse(value);
  return {
    service: serviceConfigSchema.parse({ origin: parsed.SIGN_IN_ORIGIN, cookieDomain: parsed.SIGN_IN_COOKIE_DOMAIN, clients: json(parsed.SIGN_IN_CLIENTS), fleets: json(parsed.SIGN_IN_FLEETS), trustedProxy: parsed.SIGN_IN_TRUSTED_PROXY }),
    databaseUrl: parsed.DATABASE_URL, coreUrl: parsed.CORE_URL, installationToken: parsed.INSTALLATION_TOKEN, port: parsed.PORT,
    activeKeyId: parsed.SIGN_IN_ACTIVE_KEY_ID, signingKeys: z.array(z.object({ id: z.string().min(1), file: z.string().min(1) })).min(1).parse(json(parsed.SIGN_IN_SIGNING_KEYS)),
  };
}
