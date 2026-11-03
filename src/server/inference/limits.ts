/** Active and unresolved requests retain their admission slots until settlement. */
export const INFERENCE_CONCURRENCY = {
  global: 5,
  perRoute: 5,
  perGrant: 2,
} as const;
