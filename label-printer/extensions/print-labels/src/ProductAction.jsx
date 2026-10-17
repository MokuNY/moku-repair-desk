import '@shopify/ui-extensions/preact';
import { render } from 'preact';
import { LabelPrinter } from './LabelPrinter.jsx';

export default async () => {
  const productIds = shopify.data.selected.map((s) => s.id);
  render(<LabelPrinter productIds={productIds} />, document.body);
};
