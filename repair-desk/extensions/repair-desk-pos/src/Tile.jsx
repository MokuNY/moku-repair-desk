import { render } from 'preact';

export default async () => {
  render(<RepairTile />, document.body);
};

function RepairTile() {
  return (
    <s-tile
      heading="Repair Desk"
      subheading="Check in · Find · Pick up"
      onClick={() => shopify.action.presentModal()}
    />
  );
}
