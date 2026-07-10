import { describe, it } from "mocha";
import { expect } from "chai";
import { extractPluginProperties } from "../../src/c3/addonPropertyExtractor.js";

describe("addonPropertyExtractor", () => {
  it("extracts simple property ids with no items", () => {
    const source = `
      new SDK.PluginProperty("integer", "speed", 0),
      new SDK.PluginProperty("number", "gain", 1),
    `;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "speed" }, { id: "gain" }]);
  });

  it("extracts a combo property's items array", () => {
    const source = `new SDK.PluginProperty("combo", "mode", { initialValue: "fast", items: ["fast", "slow"] })`;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "mode", items: ["fast", "slow"] }]);
  });

  it("extracts a realistic SetProperties block mixing simple, combo, and no-items props", () => {
    const source = `
      this._info.SetProperties([
        new SDK.PluginProperty("integer", "speed", 0),
        new SDK.PluginProperty("combo", "mode", { initialValue: "fast", items: ["fast", "slow"] }),
        new SDK.PluginProperty("group", "advanced"),
        new SDK.PluginProperty("link", "docs-link", { linkText: "See docs", callbackType: "documentation" }),
      ]);
    `;
    expect(extractPluginProperties(source)).to.deep.equal([
      { id: "speed" },
      { id: "mode", items: ["fast", "slow"] },
      { id: "advanced" },
      { id: "docs-link" },
    ]);
  });

  it("doesn't miscount a paren/comma embedded inside a param string literal", () => {
    const source = `new SDK.PluginProperty("text", "my, prop (x)", "a, b (c)")`;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "my, prop (x)" }]);
  });

  it("skips a property whose id is a variable reference, keeping other properties", () => {
    const source = `
      new SDK.PluginProperty("integer", SOME_VAR, 0),
      new SDK.PluginProperty("integer", "valid", 0),
    `;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "valid" }]);
  });

  it("skips a property whose id is a template literal, keeping other properties", () => {
    const source = `
      new SDK.PluginProperty("text", \`dyn_\${x}\`, ""),
      new SDK.PluginProperty("text", "afterTemplate", ""),
    `;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "afterTemplate" }]);
  });

  it("returns [] for empty source", () => {
    expect(extractPluginProperties("")).to.deep.equal([]);
  });

  it("returns [] for source with no PluginProperty calls at all", () => {
    expect(extractPluginProperties("function foo() { return 42; }")).to.deep.equal([]);
  });

  it("returns [] for garbled/malformed source, never throws", () => {
    const source = "new SDK.PluginProperty(garbage without a closing paren and no comma structure at all";
    expect(() => extractPluginProperties(source)).to.not.throw();
    expect(extractPluginProperties(source)).to.deep.equal([]);
  });

  it("skips a malformed (unmatched-paren) call site and still extracts a later well-formed one", () => {
    const source = `
      new SDK.PluginProperty(garbage without a closing paren
      new SDK.PluginProperty("integer", "afterGarbage", 0),
    `;
    expect(() => extractPluginProperties(source)).to.not.throw();
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "afterGarbage" }]);
  });

  it("handles both single- and double-quoted ids", () => {
    const source = `
      new SDK.PluginProperty('integer', 'speed', 0),
      new SDK.PluginProperty("integer", "gain", 0),
    `;
    expect(extractPluginProperties(source)).to.deep.equal([{ id: "speed" }, { id: "gain" }]);
  });
});
