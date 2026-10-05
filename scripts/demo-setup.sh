#!/usr/bin/env bash
# Create the small buggy project used by docs/demo.tape.
set -euo pipefail
dir="$1"
rm -rf "$dir"
mkdir -p "$dir/src" "$dir/test"
cd "$dir"

cat > package.json <<'JSON'
{"name": "shop", "type": "module", "scripts": {"test": "node --test test/"}}
JSON

cat > src/cart.js <<'JS'
export function cartTotal(items, discountPercent = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return subtotal - discountPercent;
}
JS

cat > test/cart.test.js <<'JS'
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cartTotal} from '../src/cart.js';

test('applies a percentage discount', () => {
  assert.equal(cartTotal([{price: 40}, {price: 60}], 10), 90);
  assert.equal(cartTotal([{price: 200}], 25), 150);
});
JS

git init -q
git add -A
git -c user.email=demo@example.com -c user.name=demo commit -qm init
