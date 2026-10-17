import { initImages } from './images';
import { initShare } from './share';
import { initClipboard } from './clipboard';
import { initTables } from './tables';

// 在 main.ts 末尾、provideV025Env 之后统一初始化；单个模块失败不影响其他模块。
export function initV025() {
  for (const init of [initImages, initShare, initClipboard, initTables]) {
    try { init(); } catch (reason) { console.error('MDRE 0.2.5 扩展初始化失败', init.name, reason); }
  }
}
