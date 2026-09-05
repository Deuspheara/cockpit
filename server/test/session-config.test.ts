import { describe, expect, it } from "vitest";
import { aiConfigurationStatus } from "../src/app.js";

describe("OpenRouter configuration status", () => {
  it.each([
    {
      name: "nothing configured",
      config: {
        OPENROUTER_API_KEY: "",
        OPENROUTER_MODEL_PRIMARY: "",
        OPENROUTER_MODEL_VISION: "",
      },
      expected: {
        keyConfigured: false,
        chatConfigured: false,
        visionConfigured: false,
      },
    },
    {
      name: "key only",
      config: {
        OPENROUTER_API_KEY: "secret-key-only",
        OPENROUTER_MODEL_PRIMARY: "",
        OPENROUTER_MODEL_VISION: "",
      },
      expected: {
        keyConfigured: true,
        chatConfigured: false,
        visionConfigured: false,
      },
    },
    {
      name: "chat ready",
      config: {
        OPENROUTER_API_KEY: "secret-chat",
        OPENROUTER_MODEL_PRIMARY: "openai/chat",
        OPENROUTER_MODEL_VISION: "",
      },
      expected: {
        keyConfigured: true,
        chatConfigured: true,
        visionConfigured: false,
      },
    },
    {
      name: "vision ready",
      config: {
        OPENROUTER_API_KEY: "secret-vision",
        OPENROUTER_MODEL_PRIMARY: "",
        OPENROUTER_MODEL_VISION: "openai/vision",
      },
      expected: {
        keyConfigured: true,
        chatConfigured: false,
        visionConfigured: true,
      },
    },
  ])("reports $name without exposing the key", ({ config, expected }) => {
    const status = aiConfigurationStatus(config);
    expect(status).toEqual(expected);
    if (config.OPENROUTER_API_KEY) {
      expect(JSON.stringify(status)).not.toContain(config.OPENROUTER_API_KEY);
    }
    expect(status).not.toHaveProperty("apiKey");
  });
});
