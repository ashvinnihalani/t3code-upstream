import { diffRouteSearchEqual, type DiffRouteSearch } from "./diffRouteSearch";

export interface ThreadDiffRouteMemoryState {
  previousThreadKey: string | null;
  previousSearch: DiffRouteSearch;
  searchByThreadKey: Record<string, DiffRouteSearch>;
}

export function createThreadDiffRouteMemoryState(input: {
  currentThreadKey: string | null;
  currentSearch: DiffRouteSearch;
}): ThreadDiffRouteMemoryState {
  return {
    previousThreadKey: input.currentThreadKey,
    previousSearch: input.currentSearch,
    searchByThreadKey: {},
  };
}

export function stepThreadDiffRouteMemory(
  state: ThreadDiffRouteMemoryState,
  input: {
    currentThreadKey: string | null;
    currentSearch: DiffRouteSearch;
  },
): {
  nextState: ThreadDiffRouteMemoryState;
  restoredSearch: DiffRouteSearch | null;
} {
  let searchByThreadKey = state.searchByThreadKey;

  if (state.previousThreadKey && state.previousThreadKey !== input.currentThreadKey) {
    const hasSavedPreviousSearch = Object.hasOwn(searchByThreadKey, state.previousThreadKey);
    const savedPreviousSearch = searchByThreadKey[state.previousThreadKey];
    if (
      !hasSavedPreviousSearch ||
      !diffRouteSearchEqual(savedPreviousSearch, state.previousSearch)
    ) {
      searchByThreadKey = {
        ...searchByThreadKey,
        [state.previousThreadKey]: state.previousSearch,
      };
    }
  }

  if (input.currentThreadKey) {
    const hasSavedCurrentSearch = Object.hasOwn(searchByThreadKey, input.currentThreadKey);
    const restoredSearch = hasSavedCurrentSearch
      ? searchByThreadKey[input.currentThreadKey]!
      : undefined;
    if (restoredSearch && !diffRouteSearchEqual(restoredSearch, input.currentSearch)) {
      return {
        nextState: {
          previousThreadKey: input.currentThreadKey,
          previousSearch: restoredSearch,
          searchByThreadKey,
        },
        restoredSearch,
      };
    }
  }

  return {
    nextState: {
      previousThreadKey: input.currentThreadKey,
      previousSearch: input.currentSearch,
      searchByThreadKey,
    },
    restoredSearch: null,
  };
}
