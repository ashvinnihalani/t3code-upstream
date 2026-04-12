import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createThreadDiffRouteMemoryState,
  stepThreadDiffRouteMemory,
} from "./threadDiffRouteMemory";

describe("threadDiffRouteMemory", () => {
  it("restores each thread's last diff selection after switching away and back", () => {
    const threadA = "env:thread-a";
    const threadB = "env:thread-b";
    const turnA = TurnId.make("turn-a");
    const turnB = TurnId.make("turn-b");
    const diffOnly = { diff: "1" as const };
    const searchA = {
      diff: "1" as const,
      diffTurnId: turnA,
      diffFilePath: "src/a.ts",
    };
    const searchB = {
      diff: "1" as const,
      diffTurnId: turnB,
      diffFilePath: "src/b.ts",
    };

    let state = createThreadDiffRouteMemoryState({
      currentThreadKey: threadA,
      currentSearch: searchA,
    });

    const switchedToB = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadB,
      currentSearch: diffOnly,
    });
    state = switchedToB.nextState;

    expect(switchedToB.restoredSearch).toBeNull();
    expect(state.searchByThreadKey[threadA]).toEqual(searchA);

    const selectedB = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadB,
      currentSearch: searchB,
    });
    state = selectedB.nextState;

    expect(selectedB.restoredSearch).toBeNull();

    const backToA = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadA,
      currentSearch: diffOnly,
    });
    state = backToA.nextState;

    expect(backToA.restoredSearch).toEqual(searchA);
    expect(state.searchByThreadKey[threadB]).toEqual(searchB);

    const committedA = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadA,
      currentSearch: searchA,
    });
    state = committedA.nextState;

    expect(committedA.restoredSearch).toBeNull();

    const backToB = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadB,
      currentSearch: diffOnly,
    });

    expect(backToB.restoredSearch).toEqual(searchB);
  });

  it("restores a thread's closed diff state over a retained open panel", () => {
    const threadA = "env:thread-a";
    const threadB = "env:thread-b";

    let state = createThreadDiffRouteMemoryState({
      currentThreadKey: threadA,
      currentSearch: {},
    });

    const switchedToB = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadB,
      currentSearch: { diff: "1" },
    });
    state = switchedToB.nextState;

    expect(switchedToB.restoredSearch).toBeNull();
    expect(state.searchByThreadKey[threadA]).toEqual({});

    const backToA = stepThreadDiffRouteMemory(state, {
      currentThreadKey: threadA,
      currentSearch: { diff: "1" },
    });

    expect(backToA.restoredSearch).toEqual({});
  });
});
