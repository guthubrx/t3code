import { describe, expect, it } from "vite-plus/test";

import { subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("garde des titres courts, sur une ligne et sans couper un mot lorsque possible", () => {
    const title = subagentThreadTitle({
      parentTitle: "Parent",
      title: "Revue des conversations sociales et des événements différés dans le monde partagé",
      prompt: "Prompt intégral conservé",
      ordinal: 1,
    });
    expect(title.length).toBeLessThanOrEqual(72);
    expect(title).toBe("Revue des conversations sociales et des événements différés dans le...");
    expect(
      subagentThreadTitle({ parentTitle: "x".repeat(200), prompt: "", ordinal: 1 }).length,
    ).toBeLessThanOrEqual(72);
    expect(
      subagentThreadTitle({
        parentTitle: "Parent",
        title: "Revue\n des   sources",
        prompt: "",
        ordinal: 1,
      }),
    ).toBe("Revue des sources");
  });

  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});
