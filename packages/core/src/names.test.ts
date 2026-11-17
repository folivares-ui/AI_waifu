import { describe, expect, it } from "vitest";
import { matchName, type NameConfig } from "./names.js";

const rice: NameConfig = {
  aliases: ["Rice Shower", "Rice"],
  heardAs: { "Rice Shower": ["rais shower", "rice chower", "rais chower", "raise shower"], Rice: ["rais", "raice"] },
};

describe("matchName", () => {
  it.each(["Rice", "rice", "rice shower", "rice Shower", "Rice shower", "RICE SHOWER", "Rice Shower"])("recognises %s", (n) => {
    const r = matchName(`Hola ${n}, ¿cómo estás?`, rice);
    expect(r.addressed).toBe(true);
    expect(r.text).toBe(`Hola ${n.toLowerCase().includes("shower") ? "Rice Shower" : "Rice"}, ¿cómo estás?`);
  });

  it("fixes how speech recognition spells it, accents and hyphens included", () => {
    expect(matchName("oye ráis shower ven", rice).text).toBe("oye Rice Shower ven");
    expect(matchName("Rais, escucha", rice).text).toBe("Rice, escucha");
    expect(matchName("RICE-SHOWER!", rice).text).toBe("Rice Shower!");
  });

  it("does not touch words that merely contain the name, and leaves other text intact", () => {
    for (const t of ["el arroz es rico", "Raíces profundas", "price", "ricevuta"]) expect(matchName(t, rice)).toEqual({ text: t, addressed: false });
    expect(matchName("Ñandú y rice juntos, ¿sí?", rice).text).toBe("Ñandú y Rice juntos, ¿sí?");
  });

  it("is a no-op without configuration", () => {
    expect(matchName("rice", undefined)).toEqual({ text: "rice", addressed: false });
  });
});
