// アプリ（iframe）の中で動く橋渡しのコード。文字列として埋め込むため、ここは素の JavaScript で書く
export const BRIDGE_CHANNEL = 'sennin-app';

const BRIDGE_SOURCE = `
(function (channel) {
  var pending = {};
  var seq = 0;
  function newId() { seq += 1; return seq + '-' + Math.random().toString(36).slice(2, 10); }
  function makeRequestId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
  function call(type, data, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = newId();
      var timer = setTimeout(function () {
        delete pending[id];
        var e = new Error('ホームからの応答がありませんでした。');
        e.code = 'timeout';
        reject(e);
      }, timeoutMs || 20000);
      pending[id] = function (m) {
        clearTimeout(timer);
        if (m.ok) resolve(m.data);
        else {
          var e = new Error(m.error || '失敗しました。');
          e.code = m.code || 'error';
          e.points = m.points;
          reject(e);
        }
      };
      parent.postMessage({ channel: channel, id: id, type: type, data: data || {} }, '*');
    });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.channel !== channel || !pending[m.id]) return;
    var f = pending[m.id];
    delete pending[m.id];
    f(m);
  });
  window.senninapp = {
    account: function () { return call('account'); },
    consent: function () { return call('consent'); },
    charge: function (amount, title, requestId) {
      return call('charge', { amount: amount, title: title, requestId: requestId || makeRequestId() }, 180000);
    },
    award: function (amount, reason, requestId) {
      return call('award', { amount: amount, reason: reason || '', requestId: requestId || makeRequestId() });
    }
  };
})(${JSON.stringify(BRIDGE_CHANNEL)});
`;

// HTML の <head> の直後に橋渡しを差し込む（無ければ先頭に置く）
export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SOURCE}</script>`;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + script)
    : script + html;
}
