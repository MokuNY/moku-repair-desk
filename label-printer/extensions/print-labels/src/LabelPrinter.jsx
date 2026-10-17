import { useEffect, useMemo, useState } from 'preact/hooks';

const MAX_QTY = 999;
const PRODUCTS_PER_QUERY = 10; // keeps GraphQL query cost low for bulk selections

const PRODUCT_QUERY = `#graphql
  query LabelProducts($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variants(first: 100) {
          pageInfo { hasNextPage }
          nodes { id title sku barcode price inventoryQuantity }
        }
      }
    }
  }`;

const VARIANT_QUERY = `#graphql
  query LabelVariants($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on ProductVariant {
        id title sku barcode price inventoryQuantity
        product { title }
      }
    }
  }`;

/**
 * Modal for choosing how many labels to print per variant.
 * Pass productIds (all variants of each product) or variantIds.
 */
export function LabelPrinter({ productIds = [], variantIds = [] }) {
  const [rows, setRows] = useState(null); // [{id, productTitle, variantTitle, sku, price, stock, qty}]
  const [currency, setCurrency] = useState('USD');
  const [printers, setPrinters] = useState([]);
  const [printer, setPrinter] = useState('');
  const [labelTypes, setLabelTypes] = useState([]);
  const [labelType, setLabelType] = useState('standard');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState(null); // {tone, text}
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadVariants(productIds, variantIds)
      .then(({ rows, currencyCode, truncated }) => {
        setRows(rows);
        setCurrency(currencyCode);
        if (truncated) {
          setNotice({ tone: 'warning', text: 'Some products have more than 100 variants; only the first 100 are listed.' });
        }
      })
      .catch((e) => setLoadError(e.message));

    fetch('/api/printers')
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Print server error');
        setPrinters(data.printers);
        setLabelTypes(data.label?.types || []);
        const online = data.printers.find((p) => p.online) || data.printers[0];
        if (online) setPrinter(online.name);
      })
      .catch((e) => setNotice({ tone: 'critical', text: `Can't reach the print server: ${e.message}` }));
  }, []);

  const total = useMemo(() => (rows || []).reduce((n, r) => n + r.qty, 0), [rows]);
  const selected = printers.find((p) => p.name === printer);
  const printerProblem = !selected
    ? 'No printer available.'
    : !selected.online
      ? `${selected.name} is offline. Check that it's on and connected to Wi-Fi.`
      : selected.problems.length
        ? `${selected.name}: ${selected.problems.join(', ').toLowerCase()}.`
        : '';

  const setQty = (id, value) => {
    const n = Math.max(0, Math.min(MAX_QTY, Math.floor(Number(value) || 0)));
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, qty: n } : r)));
  };
  const setAll = (fn) => setRows((rs) => rs.map((r) => ({ ...r, qty: Math.max(0, Math.min(MAX_QTY, fn(r))) })));

  async function print() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printer,
          labelType,
          currencyCode: currency,
          items: rows
            .filter((r) => r.qty > 0)
            .map((r) => ({
              productTitle: r.productTitle,
              variantTitle: r.variantTitle,
              sku: r.sku,
              barcode: r.barcode,
              price: r.price,
              quantity: r.qty,
            })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Print failed');
      if (data.warning) {
        setNotice({ tone: 'warning', text: data.warning });
      } else {
        shopify.toast.show(`Sent ${data.labels} label${data.labels === 1 ? '' : 's'} to ${data.printer}`);
        shopify.close();
      }
    } catch (e) {
      setNotice({ tone: 'critical', text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <s-admin-action heading="Print labels" loading={!rows && !loadError}>
      <s-stack gap="base">
        {loadError && <s-banner tone="critical">{loadError}</s-banner>}
        {notice && <s-banner tone={notice.tone}>{notice.text}</s-banner>}
        {printerProblem && !notice && printers.length > 0 && <s-banner tone="warning">{printerProblem}</s-banner>}

        {labelTypes.length > 1 && (
          <s-select label="Label type" value={labelType} onChange={(e) => setLabelType(e.currentTarget.value)}>
            {labelTypes.map((t) => (
              <s-option key={t.id} value={t.id}>
                {t.name}
              </s-option>
            ))}
          </s-select>
        )}

        {printers.length > 1 && (
          <s-select label="Printer" value={printer} onChange={(e) => setPrinter(e.currentTarget.value)}>
            {printers.map((p) => (
              <s-option key={p.name} value={p.name}>
                {p.name}
                {p.online ? '' : ' (offline)'}
              </s-option>
            ))}
          </s-select>
        )}

        {rows && rows.length > 1 && (
          <s-stack direction="inline" gap="small-200">
            <s-button onClick={() => setAll(() => 1)}>1 each</s-button>
            <s-button onClick={() => setAll((r) => r.stock)}>Match stock</s-button>
            <s-button onClick={() => setAll(() => 0)}>Clear</s-button>
          </s-stack>
        )}

        {rows && rows.length === 0 && <s-text>No variants found.</s-text>}

        {rows &&
          rows.map((r) => (
            <s-stack key={r.id} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack gap="none">
                <s-text type="strong">{r.variantTitle || r.productTitle}</s-text>
                <s-text color="subdued">
                  {[r.variantTitle ? r.productTitle : null, r.sku || 'No SKU', r.barcode ? `Barcode ${r.barcode}` : null, money(r.price, currency), `${r.stock} in stock`]
                    .filter(Boolean)
                    .join(' · ')}
                </s-text>
              </s-stack>
              <s-number-field
                label="Labels"
                labelAccessibilityVisibility="exclusive"
                min="0"
                max={String(MAX_QTY)}
                step="1"
                value={String(r.qty)}
                onChange={(e) => setQty(r.id, e.currentTarget.value)}
              />
            </s-stack>
          ))}
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        onClick={print}
        loading={busy}
        disabled={busy || !rows || total === 0 || Boolean(printerProblem && !selected?.online)}
      >
        {total === 1 ? 'Print 1 label' : `Print ${total} labels`}
      </s-button>
      <s-button slot="secondary-actions" onClick={() => shopify.close()}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}

async function loadVariants(productIds, variantIds) {
  const rows = [];
  let currencyCode = 'USD';
  let truncated = false;

  if (variantIds.length) {
    const data = await gql(VARIANT_QUERY, { ids: variantIds });
    currencyCode = data.shop.currencyCode;
    for (const v of data.nodes.filter(Boolean)) rows.push(toRow(v, v.product.title));
  }

  for (let i = 0; i < productIds.length; i += PRODUCTS_PER_QUERY) {
    const data = await gql(PRODUCT_QUERY, { ids: productIds.slice(i, i + PRODUCTS_PER_QUERY) });
    currencyCode = data.shop.currencyCode;
    for (const p of data.nodes.filter(Boolean)) {
      if (p.variants.pageInfo.hasNextPage) truncated = true;
      for (const v of p.variants.nodes) rows.push(toRow(v, p.title));
    }
  }
  return { rows, currencyCode, truncated };
}

function toRow(v, productTitle) {
  return {
    id: v.id,
    productTitle,
    variantTitle: v.title === 'Default Title' ? '' : v.title,
    sku: v.sku || '',
    barcode: v.barcode || '',
    price: v.price,
    stock: Math.max(0, v.inventoryQuantity ?? 0),
    qty: 1,
  };
}

async function gql(query, variables) {
  const res = await shopify.query(query, { variables });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; '));
  return res.data;
}

function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(amount));
  } catch {
    return String(amount);
  }
}
