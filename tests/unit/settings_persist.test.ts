// data.json persistence: the plugin must write ONLY the keys the Settings tab
// renders. data.json is the last merge layer, so persisting a YAML-only knob
// froze its config.yaml value there and shadowed config.yaml forever.

import { describe, it, expect } from "vitest";
import { settingsTabPayload } from "../../src/settings/persist";

/** A settings-shaped fixture: three rendered keys, three YAML-only keys. */
const SETTINGS = {
  agentModel: "local-model",
  apiBaseUrl: "http://127.0.0.1:8000/v1",
  embeddingDimensions: 768,
  graphClusterThreshold: 0.5,
  graphInferredThreshold: 2,
  comprehensionTokenBudget: 4000,
};

const PERSISTED = ["agentModel", "apiBaseUrl", "embeddingDimensions"] as const;

describe("settingsTabPayload", () => {
  it("keeps the persisted keys and drops every other key", () => {
    expect(settingsTabPayload(SETTINGS, PERSISTED)).toEqual({
      agentModel: "local-model",
      apiBaseUrl: "http://127.0.0.1:8000/v1",
      embeddingDimensions: 768,
    });
  });

  it("drops the YAML-only tuning keys, so config.yaml keeps authority", () => {
    const payload = settingsTabPayload(SETTINGS, PERSISTED);

    expect(payload).not.toHaveProperty("graphClusterThreshold");
    expect(payload).not.toHaveProperty("graphInferredThreshold");
    expect(payload).not.toHaveProperty("comprehensionTokenBudget");
    expect(Object.keys(payload)).toEqual([...PERSISTED]);
  });

  it("copies a value as-is, including a false boolean and an empty string", () => {
    const settings = { reasoningEnabled: false, inboxFolder: "" };

    expect(settingsTabPayload(settings, ["reasoningEnabled", "inboxFolder"])).toEqual({
      reasoningEnabled: false,
      inboxFolder: "",
    });
  });

  it("writes nothing when no key is persisted", () => {
    expect(settingsTabPayload(SETTINGS, [])).toEqual({});
  });
});
