import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/BulkAction.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-index.selection-action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/LabelPrinter.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-index.selection-action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
