/**
 * Bound how many builds one compiler isolate runs at once.
 *
 * Every request an isolate serves shares its memory, and esbuild's WebAssembly heap keeps its
 * peak. When several builds that install npm packages ran together, the isolate exceeded its
 * memory limit and the runtime failed every build in flight: as memory failures, as lost
 * connections, or as builds that never answered.
 *
 * Waiting uses promises, not an Effect semaphore. A promise settled by another request resumes
 * its waiter in the waiter's own I/O context (Workers' cross-request promise handling), so its
 * timers and fetches stay its own. A request can be cancelled while it holds a slot, without
 * running its finalizers, so each slot is a lease: after `lease` a waiter takes the slot over.
 */
import { Duration, Effect } from "effect";

interface Slot {
  readonly released: Promise<void>;
  readonly expires: number;
}

export const makeBuildAdmission = (slots: number, lease: Duration.Input) => {
  const leaseMillis = Duration.toMillis(lease);
  const held = new Set<Slot>();
  const acquire = async (): Promise<() => void> => {
    for (;;) {
      const now = Date.now();
      for (const slot of held) if (slot.expires <= now) held.delete(slot);
      if (held.size < slots) {
        let release = () => {};
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const slot = { released, expires: now + leaseMillis };
        held.add(slot);
        return () => {
          held.delete(slot);
          release();
        };
      }
      const first = Math.min(...Array.from(held, (slot) => slot.expires));
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        ...Array.from(held, (slot) => slot.released),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, first - now));
        }),
      ]);
      clearTimeout(timer);
    }
  };
  /** Run a build once a slot is free, and free the slot when the build ends. */
  return <A, E, R>(build: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.promise(acquire).pipe(Effect.withSpan("compiler.admission")),
      () => build,
      (release) => Effect.sync(release),
    );
};
