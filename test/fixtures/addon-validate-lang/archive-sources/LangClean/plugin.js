"use strict";
{
	const SDK = self.SDK;
	SDK.Plugins.LangClean = class LangCleanPlugin extends SDK.IPluginBase {
		constructor() {
			super("LangClean");
			SDK.Lang.PushContext("plugins.langclean");
			this._info.SetProperties([
				new SDK.PluginProperty("integer", "speed", 0),
				new SDK.PluginProperty("combo", "mode", { initialValue: "fast", items: ["fast", "slow"] }),
			]);
			SDK.Lang.PopContext();
		}
	};
}
