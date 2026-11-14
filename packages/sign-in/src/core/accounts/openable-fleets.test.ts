/** App discovery lists only the fleets where the signed-in account holds fleet rights. */
import { describe, expect, it } from 'vitest';

import { signInOfMaya } from '../../../test/support/sign-in-fixtures.js';
import { createOpenableFleets } from './openable-fleets.js';

describe('the fleets Maya can open', () => {
  it('lists workshop, where she holds fleet rights, and no other registered fleet', async () => {
    // Given Maya's shared sign-in with rights only in workshop.
    const fixture = await signInOfMaya();
    const shared = await fixture.authenticate();
    const openable = createOpenableFleets(fixture);

    // When the console asks which registered fleets her sign-in can open.
    const result = await openable({ signIn: shared.signIn, fleetIds: ['flt_00000000000000000000000001', 'flt_00000000000000000000000002'] });

    // Then only workshop is offered, for her account.
    expect(result).toMatchObject({ kind: 'fleets', account: { email: 'maya@example.test' }, fleetIds: ['flt_00000000000000000000000001'] });
  });

  it('offers nothing to a signed-out browser', async () => {
    // Given no live shared sign-in.
    const fixture = await signInOfMaya();
    const openable = createOpenableFleets(fixture);

    // When the console asks for its fleets.
    const result = await openable({ signIn: 'not-a-shared-sign-in', fleetIds: ['flt_00000000000000000000000001'] });

    // Then it is signed out.
    expect(result).toEqual({ kind: 'signedOut' });
  });
});
