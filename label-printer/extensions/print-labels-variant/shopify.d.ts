import '@shopify/ui-extensions';

//@ts-ignore
declare module './src/VariantAction.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}

//@ts-ignore
declare module './src/LabelPrinter.jsx' {
  const shopify: import('@shopify/ui-extensions/admin.product-variant-details.action.render').Api;
  const globalThis: { shopify: typeof shopify };
}
