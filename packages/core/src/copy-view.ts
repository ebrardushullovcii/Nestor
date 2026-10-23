/** Preserve lazy detail properties when adding read-only display facts. */
export function copyView<T extends object, U extends object>(
  value: T,
  patch: U,
): T & U {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
    descriptor.configurable = true;
    if ("value" in descriptor) descriptor.writable = true;
  }
  return Object.assign(Object.defineProperties({}, descriptors), patch) as T &
    U;
}
