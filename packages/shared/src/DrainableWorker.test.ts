import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Deferred, Effect } from "effect";

import { makeDrainableWorker } from "./DrainableWorker";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((key: string, item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(`${key}:${item}`);
          }),
        );

        yield* worker.enqueue("thread-1", "first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("thread-1", "second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["thread-1:first", "thread-1:second"]);
      }),
    ),
  );

  it.live("does not let one blocked key stop another key from processing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseFirst = yield* Deferred.make<void>();
        const secondProcessed = yield* Deferred.make<void>();
        const processed: string[] = [];

        const worker = yield* makeDrainableWorker((key: string, item: string) =>
          Effect.gen(function* () {
            if (key === "thread-1") {
              yield* Deferred.await(releaseFirst);
            }

            processed.push(`${key}:${item}`);

            if (key === "thread-2") {
              yield* Deferred.succeed(secondProcessed, undefined).pipe(Effect.orDie);
            }
          }),
        );

        yield* worker.enqueue("thread-1", "blocked");
        yield* worker.enqueue("thread-2", "ready");
        yield* Deferred.await(secondProcessed);

        expect(processed).toEqual(["thread-2:ready"]);

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* worker.drain;

        expect(processed).toEqual(["thread-2:ready", "thread-1:blocked"]);
      }),
    ),
  );
});
