/** Handwritten seal boundary: only flows issued by this fake can be opened. */
import type { Authorization, AuthorizationSeals } from '../../src/core/shared/identity.js';

let sequence = 0;

export function memoryFlowSeals(): AuthorizationSeals {
  const flows = new Map<string, Authorization>();
  return {
    seal: (authorization) => { const flow = `sealed-${++sequence}`; flows.set(flow, authorization); return Promise.resolve(flow); },
    open: (flow) => Promise.resolve(flows.get(flow) ?? null),
  };
}
