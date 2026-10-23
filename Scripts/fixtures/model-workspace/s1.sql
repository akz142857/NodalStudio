CREATE TABLE synthetic_shop.refunds (id bigint PRIMARY KEY, order_id bigint REFERENCES synthetic_shop.orders(id), amount numeric);
ALTER TABLE synthetic_shop.aux_1 ADD COLUMN category text;
