CREATE TABLE customers (
  id BINARY(16) PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE COMMENT 'Customer login email'
) COMMENT='Customer accounts';

CREATE TABLE orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  customer_id BINARY(16) NOT NULL,
  total DECIMAL(12,2) NOT NULL,
  status VARCHAR(32) NOT NULL,
  CONSTRAINT orders_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT,
  INDEX orders_status_idx (status)
);

CREATE VIEW order_totals AS SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id;
