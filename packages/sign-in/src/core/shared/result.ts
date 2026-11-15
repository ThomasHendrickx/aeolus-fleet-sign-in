/** A business outcome as a value: the success, or a failure whose kind names why. */
export type Result<T, E extends { readonly kind: string }> = { readonly isOk: true; readonly value: T } | { readonly isOk: false; readonly error: E };
