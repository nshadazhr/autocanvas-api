import { describe, expect, it } from "vitest";
import { pickActiveModelForProvider, resolveSceneVoiceProfileId } from "./voice-resolution";

describe("resolveSceneVoiceProfileId", () => {
  it("prefers the scene's own voiceProfileId when set", () => {
    const result = resolveSceneVoiceProfileId({ voiceProfileId: "scene-voice" }, { defaultVoiceId: "project-voice" });
    expect(result).toBe("scene-voice");
  });

  it("falls back to the project's defaultVoiceId when the scene has none", () => {
    const result = resolveSceneVoiceProfileId({ voiceProfileId: null }, { defaultVoiceId: "project-voice" });
    expect(result).toBe("project-voice");
  });

  it("returns null when neither the scene nor the project has a voice", () => {
    const result = resolveSceneVoiceProfileId({ voiceProfileId: null }, { defaultVoiceId: null });
    expect(result).toBeNull();
  });
});

describe("pickActiveModelForProvider", () => {
  it("returns the first active model", () => {
    const models = [
      { id: "inactive-1", isActive: false },
      { id: "active-1", isActive: true },
      { id: "active-2", isActive: true },
    ];
    expect(pickActiveModelForProvider(models)).toEqual({ id: "active-1", isActive: true });
  });

  it("returns null when no model is active", () => {
    const models = [
      { id: "inactive-1", isActive: false },
      { id: "inactive-2", isActive: false },
    ];
    expect(pickActiveModelForProvider(models)).toBeNull();
  });

  it("returns null for an empty model list", () => {
    expect(pickActiveModelForProvider([])).toBeNull();
  });
});
