import { describe, expect, it } from "vitest";
import czech from "../vendor/nightscout/translations/cs_CZ.json";
import french from "../vendor/nightscout/translations/fr_FR.json";
import traditionalChinese from "../vendor/nightscout/translations/zh_TW.json";
import {
  createNightscoutLanguage,
  type NightscoutLocalization,
} from "../src/language";

function localization(value: object): NightscoutLocalization {
  return value as NightscoutLocalization;
}

function assetFetcher(value: NightscoutLocalization): Fetcher {
  return {
    fetch: async () => Response.json(value),
  } as unknown as Fetcher;
}

/** Complete named-case mapping of locked v15.0.7 tests/language.test.js. */
describe("locked Nightscout language module", () => {
  it("uses English by default", () => {
    expect(createNightscoutLanguage().translate("Carbs")).toBe("Carbs");
  });

  it("replaces strings in translations", () => {
    const language = createNightscoutLanguage();
    expect(language.translate("%1 records deleted", "1")).toBe("1 records deleted");
    expect(language.translate("%1 records deleted", 1)).toBe("1 records deleted");
    expect(language.translate("%1 records deleted", { params: ["1"] }))
      .toBe("1 records deleted");
    expect(language.translate("Sensor age %1 days %2 hours", "1", "2"))
      .toBe("Sensor age 1 days 2 hours");
  });

  it("translates to French through the Static Assets adapter", async () => {
    const language = createNightscoutLanguage();
    language.set("fr");
    await language.loadLocalization(assetFetcher(localization(french)));
    expect(language.translate("Carbs")).toBe("Glucides");
  });

  it("translates to Czech", () => {
    const language = createNightscoutLanguage();
    language.set("cs");
    language.offerTranslations(localization(czech));
    expect(language.translate("Carbs")).toBe("Sacharidy");
  });

  it("translates Czech case-insensitively", () => {
    const language = createNightscoutLanguage();
    language.set("cs");
    language.offerTranslations(localization(czech));
    expect(language.translate("carbs", { ci: true })).toBe("Sacharidy");
  });

  it("translates to Traditional Chinese", () => {
    const language = createNightscoutLanguage();
    language.set("zh_tw");
    language.offerTranslations(localization(traditionalChinese));
    expect(language.translate("Carbs")).toBe("碳水化合物");
  });

  it("falls back to the English filename for unsupported language codes", () => {
    expect(createNightscoutLanguage().getFilename("unknown_language")).toBe("en/en.json");
  });
});
