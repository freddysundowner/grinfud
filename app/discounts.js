function validateDiscount(price, type = 'none', value = 0) {
  if (!['none', 'percent', 'fixed'].includes(type)) throw new Error('Choose a valid discount type.');
  if (type === 'none') return { discount_type: 'none', discount_value: 0 };
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new Error('Discount must be a non-negative whole number.');
  if (type === 'percent' && n > 100) throw new Error('Percentage discount cannot exceed 100%.');
  if (type === 'fixed' && n > price) throw new Error('KSh discount cannot exceed the base price.');
  return { discount_type: type, discount_value: n };
}
function discountedPrice(row) {
  const base = Number(row.price), value = Number(row.discount_value || 0);
  const sale = row.discount_type === 'percent' ? Math.round(base * (100 - value) / 100)
    : row.discount_type === 'fixed' ? base - value : base;
  return { original_price: base, price: Math.max(0, sale), discount_type: row.discount_type || 'none', discount_value: value };
}
module.exports = { validateDiscount, discountedPrice };
