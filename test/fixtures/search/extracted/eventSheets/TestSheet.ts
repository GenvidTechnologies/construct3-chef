// TestSheet TypeScript extraction fixture
import type { IRuntime } from "../../ts-defs/IRuntime";

function heroAttack(runtime: IRuntime): void {
  const alpha = runtime.globalVars.alpha;
  // heroAttack logic here
  runtime.globalVars.score += alpha * 2;
}

function heroDefend(runtime: IRuntime): void {
  runtime.globalVars.gamma = 1;
}
