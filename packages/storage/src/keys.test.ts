import { describe, it, expect } from "vitest";
import {
  validateStorageKey,
  buildOwnerScope,
  buildProjectFileKey,
  buildAudioGenerationKey,
  buildAudioExportKey,
  buildInvoicePdfKey,
} from "./keys";
import { InvalidStorageKeyError } from "./errors";

describe("validateStorageKey", () => {
  it("accepts a normal nested key", () => {
    expect(validateStorageKey("user/abc/projects/def/files/ghi.csv")).toBe("user/abc/projects/def/files/ghi.csv");
  });

  it("rejects an empty key", () => {
    expect(() => validateStorageKey("")).toThrow(InvalidStorageKeyError);
  });

  it("rejects a leading slash", () => {
    expect(() => validateStorageKey("/user/abc/file.csv")).toThrow(InvalidStorageKeyError);
  });

  it("rejects a trailing slash", () => {
    expect(() => validateStorageKey("user/abc/")).toThrow(InvalidStorageKeyError);
  });

  it("rejects path traversal ('..' segment)", () => {
    expect(() => validateStorageKey("user/abc/../../etc/passwd")).toThrow(InvalidStorageKeyError);
  });

  it("rejects a double-slash (empty segment)", () => {
    expect(() => validateStorageKey("user/abc//file.csv")).toThrow(InvalidStorageKeyError);
  });

  it("rejects backslashes", () => {
    expect(() => validateStorageKey("user\\abc\\file.csv")).toThrow(InvalidStorageKeyError);
  });

  it("rejects a key over the 1024-char S3 limit", () => {
    const tooLong = "a".repeat(1025);
    expect(() => validateStorageKey(tooLong)).toThrow(InvalidStorageKeyError);
  });
});

describe("buildOwnerScope", () => {
  it("uses org/<id> when organizationId is present", () => {
    expect(buildOwnerScope({ organizationId: "org1", userId: "user1" })).toBe("org/org1");
  });

  it("falls back to user/<id> when organizationId is null or undefined", () => {
    expect(buildOwnerScope({ organizationId: null, userId: "user1" })).toBe("user/user1");
    expect(buildOwnerScope({ userId: "user1" })).toBe("user/user1");
  });

  it("rejects an unsafe id (path-traversal attempt via a malicious org id)", () => {
    expect(() => buildOwnerScope({ organizationId: "../../etc", userId: "user1" })).toThrow(InvalidStorageKeyError);
  });
});

describe("buildProjectFileKey", () => {
  const scope = buildOwnerScope({ userId: "user1" });

  it("builds the expected path", () => {
    const key = buildProjectFileKey({ scope, projectId: "proj1", fileId: "file1", extension: "csv" });
    expect(key).toBe("user/user1/projects/proj1/files/file1.csv");
  });

  it("rejects a malicious extension used to smuggle a path (e.g. 'csv/../../secret')", () => {
    expect(() =>
      buildProjectFileKey({ scope, projectId: "proj1", fileId: "file1", extension: "csv/../../secret" }),
    ).toThrow(InvalidStorageKeyError);
  });

  it("rejects a malicious fileId containing a slash", () => {
    expect(() =>
      buildProjectFileKey({ scope, projectId: "proj1", fileId: "../../secret", extension: "csv" }),
    ).toThrow(InvalidStorageKeyError);
  });
});

describe("buildAudioGenerationKey", () => {
  it("builds the expected nested scenes/generations path", () => {
    const scope = buildOwnerScope({ organizationId: "org9", userId: "user1" });
    const key = buildAudioGenerationKey({
      scope,
      projectId: "proj1",
      sceneId: "scene1",
      generationId: "gen1",
      extension: "wav",
    });
    expect(key).toBe("org/org9/projects/proj1/audio/scenes/scene1/generations/gen1.wav");
  });
});

describe("buildAudioExportKey", () => {
  it("builds the expected exports path", () => {
    const scope = buildOwnerScope({ userId: "user1" });
    const key = buildAudioExportKey({ scope, audioProjectId: "aproj1", exportId: "exp1", extension: "mp3" });
    expect(key).toBe("user/user1/projects/aproj1/audio/exports/exp1.mp3");
  });
});

describe("buildInvoicePdfKey", () => {
  it("builds a flat invoices/<id>.pdf path with no owner scope", () => {
    expect(buildInvoicePdfKey({ invoiceId: "inv1" })).toBe("invoices/inv1.pdf");
  });
});
