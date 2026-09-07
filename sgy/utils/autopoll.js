// sgy/utils/autopoll.js —— 「页面在眼前就轮询、离开就停」的公共定时器。
// 收编 feed(10s)/ride(6s)/chat(5s) 三处手搓的 start/stop + onShow/onHide/onUnload 样板。
// 用法（页面 onLoad 初始化一次）：
//   this._poll = autopoll({ intervalMs: 6000, idleWhile: () => bool, tick: () => this.refresh() });
//   onShow(){ this._poll.start(); }  onHide/onUnload(){ this._poll.stop(); }
// start 幂等（先停再开）；idleWhile 返回 true 的那一拍跳过 tick（下拉/浮层打开时不断交互）。
function autopoll({ intervalMs, idleWhile, tick }) {
  let timer = null;
  const start = () => {
    stop();
    timer = setInterval(() => {
      if (!idleWhile || !idleWhile()) tick();
    }, intervalMs || 5000);
  };
  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return { start, stop };
}

module.exports = autopoll;
