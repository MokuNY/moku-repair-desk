-- 004 POS staff: link each Shopify POS staff member to a Repair Desk staff record,
-- so the counter knows who is working from who is pinned into POS.
ALTER TABLE staff ADD COLUMN shopify_staff_member_id TEXT;
CREATE UNIQUE INDEX staff_by_pos_member ON staff (shop_id, shopify_staff_member_id) WHERE shopify_staff_member_id IS NOT NULL;
