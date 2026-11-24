const assert = require('node:assert/strict');
const { test } = require('node:test');

const invoice = require('../lib/invoice');
const ledger = require('../lib/ledger');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function savedOrder(db, items, coupon = '', details = {}) {
  const { subtotal, discount, tax, total } = pricing.computeTotals(items, coupon);
  return orders.add(db, {
    date: '2026-01-15',
    items,
    coupon,
    subtotal,
    discount,
    tax,
    total,
    ...details
  });
}

test('prints the billed total, GST, and line breakdown for a mixed-HSN SAVE10 order', () => {
  const order = {
    id: 1001,
    date: '2026-01-15',
    items: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 500 },
      { name: 'Ghee', sku: 'GHEE', hsn: '0405', qty: 1, price: 750 }
    ],
    coupon: 'SAVE10',
    subtotal: 1750,
    discount: 150,
    tax: 128,
    total: 1728
  };

  const { total, tax } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ total, tax }, { total: order.total, tax: order.tax });

  const html = invoice.render(order);
  assert.match(html, /<td class="r">5%<\/td><td class="r">₹45\.71<\/td>/);
  assert.match(html, /<td class="r">12%<\/td><td class="r">₹82\.29<\/td>/);
  assert.match(html, /<td>CGST \+ SGST \(Total GST\)<\/td><td class="r">₹128\.00<\/td>/);
  assert.match(html, /Coupon Discount \(SAVE10\)<\/td><td[^>]+>-₹150\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹1728\.00<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice matches the billed total for an explicit whole-percent rate without a coupon', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Tea', sku: 'TEA', hsn: '0902', qty: 2, price: 50, gstRate: 18 }
  ]);

  assert.equal(order.total, 118);
  assert.deepEqual(invoice.computeInvoiceFigures(order), {
    subtotal: 100,
    discount: 0,
    tax: 18,
    cgst: 9,
    sgst: 9,
    total: 118,
    rows: [
      { name: 'Tea', sku: 'TEA', hsn: '0902', qty: 2, price: 50, gstPercent: 18, line: 100, lineTax: 18 }
    ]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice and reconciliation match Khata billing with mixed GST slabs and a capped coupon', () => {
  const db = { nextOrderId: 1, orders: [], customers: [{ id: 1, name: 'Kirana' }] };
  const order = savedOrder(db, [
    { name: 'Rice', hsn: '1006', qty: 2, price: 500 },
    { name: 'Ghee', hsn: '0405', qty: 1, price: 750 }
  ], 'SAVE10', { customer: 'Kirana', customerId: 1, paymentMode: 'khata' });
  const billed = pricing.computeTotals(order.items, order.coupon);

  assert.equal(order.subtotal, 1750);
  assert.equal(order.discount, 150);
  assert.equal(order.tax, 128);
  assert.equal(order.total, 1728);
  assert.deepEqual(billed.lines.map(({ gstPercent, discount, tax }) => (
    { gstPercent, discount, tax }
  )), [
    { gstPercent: 5, discount: 85.71, tax: 45.71 },
    { gstPercent: 12, discount: 64.29, tax: 82.29 }
  ]);
  assert.equal(billed.cgst, 64);
  assert.equal(billed.sgst, 64);
  assert.equal(ledger.chargeOrderToKhata(db, order.customerId, billed.total).ok, true);
  assert.equal(db.customers[0].totalBilled, 1728);

  const { rows, ...figures } = invoice.computeInvoiceFigures(order);
  assert.deepEqual(figures, {
    subtotal: 1750, discount: 150, tax: 128, cgst: 64, sgst: 64, total: 1728
  });
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => ({ hsn, gstPercent, lineTax })), [
    { hsn: '1006', gstPercent: 5, lineTax: 45.71 },
    { hsn: '0405', gstPercent: 12, lineTax: 82.29 }
  ]);

  assert.deepEqual(reports.getGstReconciliation(db), {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1,
      date: '2026-01-15',
      customer: 'Kirana',
      coupon: 'SAVE10',
      ledgerSubtotal: 1750,
      ledgerDiscount: 150,
      ledgerTax: 128,
      ledgerTotal: 1728,
      invoiceDiscount: 150,
      invoiceTax: 128,
      invoiceTotal: 1728,
      delta: 0,
      matched: true
    }]
  });
});

test('invoice applies a valid flat coupon before calculating GST', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Tea', qty: 1, price: 300, gstRate: 18 }
  ], 'FLAT50');

  assert.deepEqual(
    { discount: order.discount, tax: order.tax, total: order.total },
    { discount: 50, tax: 45, total: 295 }
  );
  const { discount, tax, total } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, total }, { discount: 50, tax: 45, total: 295 });
});

test('invoice keeps the billed discount after the coupon expires', () => {
  const order = {
    items: [{ name: 'Tea', qty: 1, price: 1000, gstRate: 18 }],
    coupon: 'DIWALI20',
    subtotal: 1000,
    discount: 200,
    tax: 144,
    total: 944
  };

  const { discount, tax, total, rows } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ discount, tax, total }, { discount: 200, tax: 144, total: 944 });
  assert.equal(rows[0].lineTax, 144);
});

test('invoice preserves the flat GST charged before the HSN slab migration', () => {
  const order = {
    date: '21/07/2021',
    items: [
      { name: 'Rice', hsn: '1006', qty: 1, price: 640 },
      { name: 'Tea', hsn: '0902', qty: 1, price: 140 }
    ],
    subtotal: 780,
    discount: 0,
    tax: 140.4,
    total: 920.4
  };

  const { tax, total, rows } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ tax, total }, { tax: 140.4, total: 920.4 });
  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 18, lineTax: 115.2 },
    { gstPercent: 18, lineTax: 25.2 }
  ]);
});

test('invoice preserves the recorded GST and total for a rounded pre-migration coupon', () => {
  const order = {
    date: '21/07/2021',
    items: [{ name: 'Tea', hsn: '0902', qty: 1, price: 100.26 }],
    coupon: 'WELCOME',
    subtotal: 100.26,
    discount: 5.01,
    tax: 17.14,
    total: 112.39
  };

  const { tax, total, rows } = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ tax, total, lineTax: rows[0].lineTax }, {
    tax: 17.14, total: 112.39, lineTax: 17.14
  });
});

test('invoice uses checkout line rounding on the HSN migration date', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Tea A', hsn: '0902', qty: 1, price: 150.02 },
    { name: 'Tea B', hsn: '0902', qty: 1, price: 150.02 },
    { name: 'Tea C', hsn: '0902', qty: 1, price: 150.03 }
  ], '', { date: '22/07/2021' });

  assert.deepEqual(invoice.computeInvoiceFigures(order).rows.map((row) => row.lineTax), [
    27, 27, 27.01
  ]);
});

test('reconciliation still flags an inconsistent pre-migration order total', () => {
  const order = {
    id: 1, date: '21/07/2021',
    items: [{ name: 'Tea', qty: 1, price: 100 }],
    subtotal: 100, discount: 0, tax: 18, total: 120
  };

  assert.equal(invoice.computeInvoiceFigures(order).total, 118);
  assert.match(invoice.render(order), /Accountant Reconciliation Notice/);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, false);
});

test('invoice recognizes a flat-rate charge on the HSN migration date', () => {
  const order = {
    date: '22/07/2021',
    items: [{ name: 'Rice', hsn: '1006', qty: 1, price: 100 }],
    subtotal: 100, discount: 0, tax: 18, total: 118
  };
  const { tax, total, rows } = invoice.computeInvoiceFigures(order);

  assert.deepEqual({ tax, total, rate: rows[0].gstPercent }, { tax: 18, total: 118, rate: 18 });
});

test('reconciliation flags a recorded discount when the order has no coupon', () => {
  const order = {
    id: 1, date: '2026-01-15',
    items: [{ name: 'Tea', qty: 1, price: 100 }],
    subtotal: 100, discount: 10, tax: 16.2, total: 106.2
  };

  assert.equal(invoice.computeInvoiceFigures(order).total, 118);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, false);
});

test('reconciliation flags a recorded discount that conflicts with an active coupon', () => {
  const order = {
    id: 1, date: '2026-01-15', coupon: 'WELCOME',
    items: [{ name: 'Tea', qty: 1, price: 100 }],
    subtotal: 100, discount: 10, tax: 16.2, total: 106.2
  };

  assert.equal(invoice.computeInvoiceFigures(order).total, 112.1);
  assert.equal(reports.getGstReconciliation({ orders: [order] }).rows[0].matched, false);
});

test('invoice shows the rounding adjustment when displayed legacy amounts differ by a paisa', () => {
  const order = {
    id: 1, date: '21/07/2021', coupon: 'WELCOME',
    items: [{ name: 'Tea', qty: 1, price: 100.10 }],
    subtotal: 100.10, discount: 5.01, tax: 17.12, total: 112.22
  };

  const html = invoice.render(order);
  assert.match(html, /Rounding Adjustment<\/td><td class="r">\+₹0\.01<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹112\.22<\/td>/);
});

const couponCases = [
  { description: 'ignores an expired coupon', code: 'DIWALI20', price: 1000, discount: 0, total: 1180 },
  { description: 'ignores a flat coupon below its minimum', code: 'FLAT50', price: 20, discount: 0, total: 23.6 },
  { description: 'trims and uppercases a stored coupon', code: ' welcome ', price: 100, discount: 5, total: 112.1 }
];

for (const { description, code, price, discount, total } of couponCases) {
  test('without a recorded discount, invoice ' + description, () => {
    const items = [{ name: 'Tea', qty: 1, price, gstRate: 18 }];
    assert.equal(pricing.computeTotals(items, code).total, total);
    const actual = invoice.computeInvoiceFigures({ items, coupon: code });
    assert.equal(actual.discount, discount);
    assert.equal(actual.total, total);
  });
}

test('invoice treats fractional and zero GST rates the same way as checkout', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Rice', qty: 1, price: 100, gstRate: 0.05 },
    { name: 'Exempt item', qty: 1, price: 10, gstRate: 0 }
  ]);
  const billed = pricing.computeTotals(order.items, order.coupon);
  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => ({ gstPercent, tax })), [
    { gstPercent: 5, tax: 5 },
    { gstPercent: 0, tax: 0 }
  ]);
  assert.equal(order.total, 115);

  const actual = invoice.computeInvoiceFigures(order);
  assert.deepEqual(actual.rows.map(({ gstPercent, lineTax }) => ({ gstPercent, lineTax })), [
    { gstPercent: 5, lineTax: 5 },
    { gstPercent: 0, lineTax: 0 }
  ]);
  assert.equal(actual.tax, 5);
  assert.equal(actual.total, 115);
});

test('invoice GST sums the rounded line taxes and splits that sum into CGST and SGST', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Sample A', qty: 1, price: 0.03, gstRate: 18 },
    { name: 'Sample B', qty: 1, price: 0.03, gstRate: 18 }
  ]);
  assert.equal(order.tax, 0.02);
  assert.equal(order.total, 0.08);

  const actual = invoice.computeInvoiceFigures(order);
  assert.deepEqual(actual.rows.map((row) => row.lineTax), [0.01, 0.01]);
  assert.equal(actual.tax, 0.02);
  assert.equal(actual.cgst, 0.01);
  assert.equal(actual.sgst, 0.01);
  assert.equal(actual.total, 0.08);
});

test('an eligible percentage coupon produces matching GST in the invoice and reconciliation', () => {
  const db = { nextOrderId: 1, orders: [] };
  const order = savedOrder(db, [
    { name: 'Tea', qty: 1, price: 100, gstRate: 18 }
  ], 'WELCOME');
  const actual = invoice.computeInvoiceFigures(order);

  assert.equal(order.total, 112.1);
  assert.equal(actual.total, 112.1);
  assert.equal(order.tax, 17.1);
  assert.equal(actual.tax, 17.1);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);

  const report = reports.getGstReconciliation(db);
  assert.equal(report.mismatchCount, 0);
  assert.equal(report.totalDelta, 0);
  assert.equal(report.rows[0].matched, true);
  assert.equal(report.rows[0].delta, 0);
});
