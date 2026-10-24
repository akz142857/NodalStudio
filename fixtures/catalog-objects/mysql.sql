CREATE TABLE IF NOT EXISTS catalog_accounts (id integer PRIMARY KEY, balance decimal(12,2) NOT NULL, CONSTRAINT catalog_balance_check CHECK (balance >= 0));
DROP FUNCTION IF EXISTS catalog_echo;
CREATE DEFINER='nodalstudio'@'%' FUNCTION catalog_echo(value_in integer) RETURNS integer DETERMINISTIC NO SQL RETURN value_in;
DROP PROCEDURE IF EXISTS catalog_read_accounts;
CREATE DEFINER='nodalstudio'@'%' PROCEDURE catalog_read_accounts(IN min_balance decimal(12,2)) SELECT id FROM catalog_accounts WHERE balance >= min_balance;
DROP TRIGGER IF EXISTS catalog_account_guard;
CREATE TRIGGER catalog_account_guard BEFORE INSERT ON catalog_accounts FOR EACH ROW SET NEW.balance = ABS(NEW.balance);
CREATE OR REPLACE VIEW catalog_account_view AS SELECT * FROM catalog_accounts;
CREATE TABLE IF NOT EXISTS catalog_index_cases (id integer PRIMARY KEY, label varchar(100), UNIQUE KEY catalog_label_unique(label), KEY catalog_label_prefix(label(12) DESC), KEY catalog_label_expression((lower(label))));

DROP FUNCTION IF EXISTS catalog_hidden;
CREATE FUNCTION catalog_hidden() RETURNS integer DETERMINISTIC NO SQL RETURN 1;
