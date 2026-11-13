const items = [
  { id: 'mug', name: 'Ceramic mug', price: 1250, qty: 1 },
  { id: 'beans', name: 'Coffee beans, 250 g', price: 1250, qty: 1 },
];

const freeShippingFrom = 5000;
const shippingFee = 500;
let couponPercent = 0;

function money(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function subtotal() {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function buildRows() {
  const body = document.getElementById('items');
  for (const item of items) {
    const row = document.createElement('tr');

    const name = document.createElement('td');
    name.textContent = item.name;

    const price = document.createElement('td');
    price.textContent = money(item.price);

    const qtyCell = document.createElement('td');
    const qty = document.createElement('input');
    qty.type = 'number';
    qty.min = '1';
    qty.max = '10';
    qty.value = String(item.qty);
    qty.id = 'qty-' + item.id;
    qty.setAttribute('aria-label', 'Quantity of ' + item.name);
    qty.addEventListener('input', () => {
      const n = parseInt(qty.value, 10);
      if (Number.isInteger(n) && n >= 1 && n <= 10) {
        item.qty = n;
        render();
      }
    });
    qtyCell.appendChild(qty);

    const line = document.createElement('td');
    line.id = 'line-' + item.id;

    row.append(name, price, qtyCell, line);
    body.appendChild(row);
  }
}

function render() {
  for (const item of items) {
    document.getElementById('line-' + item.id).textContent = money(item.price * item.qty);
  }
  const sub = subtotal();
  const discount = Math.round((sub * couponPercent) / 100);
  const shipping = sub >= freeShippingFrom ? 0 : shippingFee;
  document.getElementById('subtotal').textContent = money(sub);
  document.getElementById('discount').textContent = discount ? '-' + money(discount) : money(0);
  document.getElementById('shipping').textContent = shipping ? money(shipping) : 'Free';
  document.getElementById('total').textContent = money(sub - discount + shipping);
}

async function lookupCoupon(code) {
  try {
    const res = await fetch('coupons.json', { cache: 'no-store' });
    if (!res.ok) return 0;
    const data = await res.json();
    const match = (data.codes || []).find((c) => String(c.code).toLowerCase() === code.toLowerCase());
    return match ? Number(match.percent_off) || 0 : 0;
  } catch (e) {
    return 0;
  }
}

document.getElementById('coupon-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = document.getElementById('coupon').value.trim();
  const percent = code ? await lookupCoupon(code) : 0;
  const message = document.getElementById('coupon-message');
  if (percent) {
    couponPercent = percent;
    message.textContent = 'Coupon applied: ' + percent + '% off your items.';
  } else {
    couponPercent = 0;
    message.textContent = 'That code is not valid.';
  }
  render();
});

buildRows();
render();
