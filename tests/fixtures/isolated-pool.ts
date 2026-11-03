import type { Pool } from 'pg';

/** A fresh application identity with bound access to the suite's disposable SQL pool. */
export function isolatedPool(pool: Pool): Pool {
  return new Proxy(pool, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
