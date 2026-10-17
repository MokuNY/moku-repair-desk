import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { LabelPrinter } from './LabelPrinter.jsx';

export default async () => {
  const variantIds = shopify.data.selected.map((s) => s.id);
  render(<LabelPrinter variantIds={variantIds} />, document.body);
};
