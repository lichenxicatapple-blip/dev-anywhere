// 写 inline style 之前对比上次值，相同则跳过——避免无意义的 DOM 写引起额外
// reflow / paint。每个 writer 实例自带 cache，dispose 不显式清，跟随闭包 GC。
interface PtyStyleWriter {
  set: (el: HTMLElement, prop: string, value: string) => void;
}

export function createPtyStyleWriter(): PtyStyleWriter {
  const caches = new WeakMap<HTMLElement, Map<string, string>>();
  return {
    set(el, prop, value) {
      let cache = caches.get(el);
      if (!cache) {
        cache = new Map();
        caches.set(el, cache);
      }
      if (cache.get(prop) === value) return;
      cache.set(prop, value);
      (el.style as unknown as Record<string, string>)[prop] = value;
    },
  };
}
