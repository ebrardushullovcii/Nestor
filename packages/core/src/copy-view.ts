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
  for (const key of Reflect.ownKeys(patch)) {
    if (Object.getOwnPropertyDescriptor(patch, key)?.enumerable)
      Reflect.set(descriptors, key, {
        value: Reflect.get(patch, key),
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return Object.defineProperties({}, descriptors) as T & U;
}
