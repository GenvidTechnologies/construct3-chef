"use strict";
{
	const SDK = self.SDK;
	SDK.Plugins.LangDefects = class LangDefectsPlugin extends SDK.IPluginBase {
		constructor() {
			super("LangDefects");
			SDK.Lang.PushContext("plugins.langdefects");
			this._info.SetProperties([
				new SDK.PluginProperty("integer", "speed", 0),
				new SDK.PluginProperty("combo", "mode", { initialValue: "fast", items: ["fast", "slow"] }),
			]);
			SDK.Lang.PopContext();
		}
	};
}
