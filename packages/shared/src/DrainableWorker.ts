/**
 * DrainableWorker - A keyed queue-based worker with a global `drain()` effect.
 *
 * Each key is processed serially, while different keys may run concurrently.
 * This allows thread-scoped work to avoid head-of-line blocking across
 * unrelated keys while still preserving in-order processing per key.
 *
 * We intentionally do not implement `drainKey()`: there is no current
 * production use case for per-key draining, and carrying that API would add
 * state and semantics we do not need.
 *
 * @module DrainableWorker
 */
import { Effect, Exit, Scope, TxRef } from "effect";

export interface DrainableWorker<K, A> {
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

interface DrainableWorkerState<K, A> {
  readonly queuedByKey: Map<K, ReadonlyArray<A>>;
  readonly activeKeys: Set<K>;
  readonly totalOutstanding: number;
}

export const makeDrainableWorker = <K, A, E, R>(
  process: (key: K, item: A) => Effect.Effect<void, E, R>,
): Effect.Effect<DrainableWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));

    const stateRef = yield* TxRef.make<DrainableWorkerState<K, A>>({
      queuedByKey: new Map(),
      activeKeys: new Set(),
      totalOutstanding: 0,
    });

    const takeNext = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const queued = state.queuedByKey.get(key);
        if (queued === undefined || queued.length === 0) {
          const queuedByKey = new Map(state.queuedByKey);
          queuedByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.delete(key);
          return [null, { ...state, queuedByKey, activeKeys }] as const;
        }

        const queuedByKey = new Map(state.queuedByKey);
        if (queued.length === 1) {
          queuedByKey.delete(key);
        } else {
          queuedByKey.set(key, queued.slice(1));
        }
        return [queued[0] ?? null, { ...state, queuedByKey }] as const;
      }).pipe(Effect.tx);

    const completeOne = TxRef.update(stateRef, (state) => ({
      ...state,
      totalOutstanding: Math.max(0, state.totalOutstanding - 1),
    })).pipe(Effect.tx);

    const runKey = (key: K): Effect.Effect<void, E, R> =>
      takeNext(key).pipe(
        Effect.flatMap((item) =>
          item === null
            ? Effect.void
            : process(key, item).pipe(Effect.ensuring(completeOne), Effect.andThen(runKey(key))),
        ),
      );

    const enqueue: DrainableWorker<K, A>["enqueue"] = (key, item) =>
      TxRef.modify(stateRef, (state) => {
        const queuedByKey = new Map(state.queuedByKey);
        queuedByKey.set(key, [...(queuedByKey.get(key) ?? []), item]);

        if (state.activeKeys.has(key)) {
          return [
            false,
            {
              ...state,
              queuedByKey,
              totalOutstanding: state.totalOutstanding + 1,
            },
          ] as const;
        }

        const activeKeys = new Set(state.activeKeys);
        activeKeys.add(key);

        return [
          true,
          {
            ...state,
            queuedByKey,
            activeKeys,
            totalOutstanding: state.totalOutstanding + 1,
          },
        ] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((shouldStart) =>
          shouldStart
            ? runKey(key).pipe(Effect.provide(context), Effect.forkIn(workerScope), Effect.asVoid)
            : Effect.void,
        ),
      );

    const drain: DrainableWorker<K, A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.totalOutstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies DrainableWorker<K, A>;
  });
