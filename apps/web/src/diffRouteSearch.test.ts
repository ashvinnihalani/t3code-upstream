import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { diffRouteSearchEqual, parseDiffRouteSearch } from "./diffRouteSearch";

describe("parseDiffRouteSearch", () => {
  it("parses valid diff search values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });
  });

  it("treats numeric and boolean diff toggles as open", () => {
    expect(
      parseDiffRouteSearch({
        diff: 1,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });

    expect(
      parseDiffRouteSearch({
        diff: true,
        diffTurnId: "turn-1",
      }),
    ).toEqual({
      diff: "1",
      diffTurnId: "turn-1",
    });
  });

  it("drops turn and file values when diff is closed", () => {
    const parsed = parseDiffRouteSearch({
      diff: "0",
      diffTurnId: "turn-1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({});
  });

  it("drops file value when turn is not selected", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffFilePath: "src/app.ts",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });

  it("normalizes whitespace-only values", () => {
    const parsed = parseDiffRouteSearch({
      diff: "1",
      diffTurnId: "  ",
      diffFilePath: "  ",
    });

    expect(parsed).toEqual({
      diff: "1",
    });
  });
});

describe("diffRouteSearchEqual", () => {
  const turnId = TurnId.make("turn-1");
  const otherTurnId = TurnId.make("turn-2");

  it("matches identical diff search state", () => {
    expect(
      diffRouteSearchEqual(
        {
          diff: "1",
          diffTurnId: turnId,
          diffFilePath: "src/app.ts",
        },
        {
          diff: "1",
          diffTurnId: turnId,
          diffFilePath: "src/app.ts",
        },
      ),
    ).toBe(true);
  });

  it("treats missing and differing fields as unequal", () => {
    expect(diffRouteSearchEqual(undefined, {})).toBe(true);
    expect(
      diffRouteSearchEqual(
        {
          diff: "1",
          diffTurnId: turnId,
        },
        {
          diff: "1",
          diffTurnId: otherTurnId,
        },
      ),
    ).toBe(false);
    expect(
      diffRouteSearchEqual(
        {
          diff: "1",
          diffTurnId: turnId,
          diffFilePath: "src/app.ts",
        },
        {
          diff: "1",
          diffTurnId: turnId,
          diffFilePath: "src/other.ts",
        },
      ),
    ).toBe(false);
  });
});
