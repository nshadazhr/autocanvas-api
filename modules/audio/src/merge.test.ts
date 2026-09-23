import { describe, expect, it } from "vitest";
import { validateMergeSelection, describeMergeValidationErrors, type MergeableScene } from "./merge";

const scenes: MergeableScene[] = [
  { id: "s1", orderIndex: 0, status: "COMPLETED" },
  { id: "s2", orderIndex: 1, status: "COMPLETED" },
  { id: "s3", orderIndex: 2, status: "FAILED" },
  { id: "s4", orderIndex: 3, status: "PENDING" },
];

describe("validateMergeSelection", () => {
  it("returns EMPTY_SELECTION when nothing is selected", () => {
    const result = validateMergeSelection({ availableScenes: scenes, selectedSceneIds: [] });
    expect(result).toEqual({ ok: false, errors: [{ reason: "EMPTY_SELECTION" }] });
  });

  it("returns ordered scene ids (by orderIndex, not selection order) when all selected scenes are COMPLETED", () => {
    const result = validateMergeSelection({ availableScenes: scenes, selectedSceneIds: ["s2", "s1"] });
    expect(result).toEqual({ ok: true, orderedSceneIds: ["s1", "s2"] });
  });

  it("flags a selected id that doesn't exist on the project as NOT_FOUND", () => {
    const result = validateMergeSelection({ availableScenes: scenes, selectedSceneIds: ["s1", "does-not-exist"] });
    expect(result).toEqual({
      ok: false,
      errors: [{ reason: "NOT_FOUND", sceneId: "does-not-exist" }],
    });
  });

  it("flags a selected scene that isn't COMPLETED as NOT_COMPLETED, carrying its actual status", () => {
    const result = validateMergeSelection({ availableScenes: scenes, selectedSceneIds: ["s3"] });
    expect(result).toEqual({
      ok: false,
      errors: [{ reason: "NOT_COMPLETED", sceneId: "s3", status: "FAILED" }],
    });
  });

  it("collects every problem across the whole selection in one pass, not just the first", () => {
    const result = validateMergeSelection({
      availableScenes: scenes,
      selectedSceneIds: ["s3", "s4", "missing"],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        { reason: "NOT_COMPLETED", sceneId: "s3", status: "FAILED" },
        { reason: "NOT_COMPLETED", sceneId: "s4", status: "PENDING" },
        { reason: "NOT_FOUND", sceneId: "missing" },
      ],
    });
  });

  it("de-duplicates repeated ids in the selection instead of erroring", () => {
    const result = validateMergeSelection({ availableScenes: scenes, selectedSceneIds: ["s1", "s1", "s2"] });
    expect(result).toEqual({ ok: true, orderedSceneIds: ["s1", "s2"] });
  });
});

describe("describeMergeValidationErrors", () => {
  it("renders a human-readable sentence for each error reason", () => {
    expect(describeMergeValidationErrors([{ reason: "EMPTY_SELECTION" }])).toBe("no scenes were selected");
    expect(describeMergeValidationErrors([{ reason: "NOT_FOUND", sceneId: "s9" }])).toBe(
      "scene s9 does not belong to this project",
    );
    expect(describeMergeValidationErrors([{ reason: "NOT_COMPLETED", sceneId: "s3", status: "FAILED" }])).toBe(
      "scene s3 is not ready yet (status: FAILED)",
    );
  });

  it("joins multiple errors with a semicolon", () => {
    const message = describeMergeValidationErrors([
      { reason: "NOT_FOUND", sceneId: "a" },
      { reason: "NOT_COMPLETED", sceneId: "b", status: "PENDING" },
    ]);
    expect(message).toBe("scene a does not belong to this project; scene b is not ready yet (status: PENDING)");
  });
});
