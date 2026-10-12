const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(__dirname + '/public/chat-widget.js', 'utf8');
const openSource = source.slice(source.indexOf('  async function open(trigger)'), source.indexOf('  function lock(on)'));

async function route(menu) {
  const calls = [];
  let visible = false;
  const context = {
    opening: false, view: null,
    // Simulate the stale two-channel settings left from the original page load.
    channels: { website_chat_enabled: true, whatsapp_chat_enabled: true },
    voiceReset() {}, lock() {}, vv() {}, xBtn() {},
    el: () => ({ setAttribute() {}, append() {} }),
    bg: {
      classList: { add() { visible = true; }, contains() { return visible; } },
      replaceChildren() {},
    },
    fetchChannels: async () => {
      calls.push('fetch');
      if (!menu.website_chat_enabled && !menu.whatsapp_chat_enabled) visible = false;
      return menu;
    },
    waUrl: m => m.whatsapp_url || '',
    openChat: () => calls.push('website'),
    openChooser: () => calls.push('chooser'),
    close: () => { visible = false; },
    window: { location: { assign: url => calls.push(url) } },
  };
  await vm.runInNewContext(openSource + '\nopen();', context);
  return calls;
}

test('fresh website-only setting overrides cached two-channel setting', async () => {
  assert.deepEqual(await route({ website_chat_enabled: true, whatsapp_chat_enabled: false }), ['fetch', 'website']);
});
test('fresh WhatsApp-only setting opens the connected number directly', async () => {
  const url = 'https://wa.me/254700000000';
  assert.deepEqual(await route({ website_chat_enabled: false, whatsapp_chat_enabled: true, whatsapp_url: url }), ['fetch', url]);
});
test('both connected channels show a chooser', async () => {
  assert.deepEqual(await route({ website_chat_enabled: true, whatsapp_chat_enabled: true, whatsapp_url: 'https://wa.me/254700000000' }), ['fetch', 'chooser']);
});
test('unconnected WhatsApp does not add a choice alongside website chat', async () => {
  assert.deepEqual(await route({ website_chat_enabled: true, whatsapp_chat_enabled: true, whatsapp_url: '' }), ['fetch', 'website']);
});
test('neither enabled does not open a chooser', async () => {
  assert.deepEqual(await route({ website_chat_enabled: false, whatsapp_chat_enabled: false }), ['fetch']);
});
