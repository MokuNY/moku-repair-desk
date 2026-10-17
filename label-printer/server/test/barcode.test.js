import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBarcode, gtinValid, moduleWidth } from '../src/barcode.js';

test('GS1 check digits', () => {
  assert.ok(gtinValid('012345678905')); // UPC-A
  assert.ok(!gtinValid('012345678901'));
  assert.ok(gtinValid('4006381333931')); // EAN-13
  assert.ok(gtinValid('96385074')); // EAN-8
});

test('vendor barcode wins, SKU is the fallback', () => {
  assert.equal(chooseBarcode({ barcode: '012345678905', sku: 'X-1' }).kind, 'UPCA');
  assert.equal(chooseBarcode({ barcode: '4006381333931', sku: 'X-1' }).kind, 'EAN13');
  assert.equal(chooseBarcode({ barcode: '', sku: 'MOKU-TEE-BLK-M' }).kind, 'CODE128');
  assert.equal(chooseBarcode({ barcode: '1000234567' }).kind, 'CODE128C');
  // A 12-digit value with a bad check digit is not a UPC; encode it verbatim.
  assert.equal(chooseBarcode({ barcode: '012345678901' }).kind, 'CODE128C');
  assert.equal(chooseBarcode({ barcode: '', sku: '' }), null);
});

test('barcode fits 2" labels at 203 and 300 dpi', () => {
  const upc = chooseBarcode({ barcode: '012345678905' });
  assert.equal(moduleWidth(upc, 203, 382, 406), 3);
  assert.equal(moduleWidth(upc, 300, 564, 600), 4);
  const sku14 = chooseBarcode({ sku: 'MOKU-TEE-BLK-M' });
  assert.equal(moduleWidth(sku14, 203, 382, 406), 2);
  const sku20 = chooseBarcode({ sku: 'MOKU-TEE-BLK-M-EXTRA' });
  assert.equal(moduleWidth(sku20, 203, 382, 406), 0); // too long to scan reliably at 203 dpi
  assert.ok(moduleWidth(sku20, 300, 564, 600) >= 2);
});

test('odd-length numeric codes use subset C then B for the last digit', async () => {
  const { chooseBarcode, barcodeZpl } = await import('../src/barcode.js');
  const sym = chooseBarcode({ sku: '08461802840' });
  assert.equal(sym.kind, 'CODE128CB');
  assert.equal(sym.modules, 112);
  assert.match(barcodeZpl(sym, 0, 0, 1, 50, (x) => x), /\^FD>;0846180284>60\^FS/);
});
