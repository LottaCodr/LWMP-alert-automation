-- Atomic parish member-code allocation prevents concurrent staff saves from reusing a code.
CREATE SEQUENCE IF NOT EXISTS member_code_sequence START WITH 1001;
