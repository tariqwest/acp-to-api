import { describe, expect, it } from "bun:test";
import { buildCapabilityCard, modelCardExtras } from "./capabilities.ts";

describe("capabilities", () => {
  it("builds matrix with summary buckets", () => {
    const card = buildCapabilityCard();
    expect(card.object).toBe("acp_to_api.capabilities");
    expect(card.summary.enforced).toContain("models.list");
    expect(card.summary.ignored).toContain("temperature");
    expect(card.summary.unsupported).toContain("embeddings");
  });

  it("model card extras", () => {
    const e = modelCardExtras();
    expect(e.capabilities.n).toBe(1);
    expect(e.sampling.temperature).toBe("ignored");
  });
});
