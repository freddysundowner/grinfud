// Only unambiguous, exact phrases take this fast path. Never infer confirmation,
// cancellation, delivery details, or basket mutations from approximate matches.
module.exports = function shortcut(text, state, menu) {
  const phrase = text.trim().toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  const aliases = {
    'show menu': 'MENU', 'show me the menu': 'MENU', 'show the menu': 'MENU',
    "what's on the menu": 'MENU', 'what is on the menu': 'MENU',
    'my basket': 'BASKET', 'show my basket': 'BASKET', 'view basket': 'BASKET',
    'my cart': 'BASKET', 'show my cart': 'BASKET', 'view cart': 'BASKET',
    'order status': 'STATUS', 'where is my order': 'STATUS', "where's my order": 'STATUS',
    'track my order': 'STATUS', 'my orders': 'ORDERS',
    'talk to the team': 'AGENT', 'talk to a person': 'AGENT',
    'ready to checkout': 'CHECKOUT', 'check out': 'CHECKOUT'
  };
  if (Object.hasOwn(aliases, phrase)) return aliases[phrase];
  if (state.step === 'menu') {
    const item = menu.items.find(i => i.name.toLowerCase() === phrase);
    if (item) return item.name;
  }
  if (state.step === 'options') {
    const group = menu.items.find(i => i.id === state.draft?.item_id)?.options[state.group];
    const labels = text.split(',').map(v => v.trim());
    if (group && labels.every(label => group.choices.some(c => c.label.toLowerCase() === label.toLowerCase()))) return text;
  }
  if (state.step === 'quantity') {
    const number = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(phrase);
    if (number >= 0) return String(number);
  }
  if (state.step === 'notes' && ['no notes', 'none', 'no', 'no thanks'].includes(phrase)) return '0';
  return null;
};
