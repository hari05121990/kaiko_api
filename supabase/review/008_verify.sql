-- =============================================================================
-- Kaiko Kart – Migration 008 post-apply verification (READ-ONLY)
-- =============================================================================
-- Run after 008 is applied. Every query is a catalog read; nothing is written.
-- Expected result: every row's "ok" column is true.
-- =============================================================================

BEGIN READ ONLY;

-- 1. All 12 functions exist, are SECURITY DEFINER, pin search_path='' and share
--    the table owner.
WITH f(sig) AS (VALUES
    ('public.has_global_admin_role()'),
    ('public.is_staff_or_admin()'),
    ('public.can_access_store(uuid)'),
    ('public.admin_credit_points(uuid, numeric, text, uuid, text)'),
    ('public.admin_adjust_points(uuid, text, bigint, text, text)'),
    ('public.admin_reverse_points(uuid, text, text)'),
    ('public.admin_create_customer_profile(uuid, text, text, text, text, text, text, text)'),
    ('public.admin_list_customers(text, text, integer, integer)'),
    ('public.admin_get_customer(uuid)'),
    ('public.admin_update_customer(uuid, text, text, text, text, text, text)'),
    ('public.admin_set_customer_status(uuid, text, text)'),
    ('public.admin_update_order_status(uuid, text, text)')
)
SELECT
    f.sig,
    p.prosecdef AS security_definer,
    p.proconfig AS config,
    pg_catalog.pg_get_userbyid(p.proowner) AS owner,
    (p.oid IS NOT NULL
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']
        AND pg_catalog.pg_get_userbyid(p.proowner) = (
            SELECT pg_catalog.pg_get_userbyid(c.relowner)
            FROM pg_catalog.pg_class c WHERE c.oid = 'public.profiles'::regclass)
    ) AS ok
FROM f
LEFT JOIN pg_catalog.pg_proc p ON p.oid = pg_catalog.to_regprocedure(f.sig)
ORDER BY f.sig;

-- 2. EXECUTE: authenticated + service_role yes; anon and PUBLIC no.
SELECT
    p.oid::regprocedure AS function,
    pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
    pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
    pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
    NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        WHERE a.grantee = 0
    ) AS public_revoked,
    (pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
     AND pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
     AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
     AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
        WHERE a.grantee = 0)
    ) AS ok
FROM pg_catalog.pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN (
      'has_global_admin_role', 'is_staff_or_admin', 'can_access_store',
      'admin_credit_points', 'admin_adjust_points', 'admin_reverse_points',
      'admin_create_customer_profile', 'admin_list_customers', 'admin_get_customer',
      'admin_update_customer', 'admin_set_customer_status', 'admin_update_order_status')
ORDER BY 1;

-- 3. G1/G2 guards are present in the live bodies.
SELECT p.proname,
       (p.prosrc LIKE '%[008/G1]%' OR p.proname IN ('has_global_admin_role', 'is_staff_or_admin', 'can_access_store'))
       AND (p.proname NOT IN ('has_global_admin_role', 'is_staff_or_admin', 'can_access_store')
            OR p.prosrc LIKE '%p.status = ''ACTIVE''%') AS ok
FROM pg_catalog.pg_proc p
WHERE p.pronamespace = 'public'::regnamespace
  AND p.proname IN ('has_global_admin_role', 'is_staff_or_admin', 'can_access_store',
                    'admin_credit_points', 'admin_adjust_points', 'admin_reverse_points')
ORDER BY 1;

-- 4. Earning ratio unchanged.
SELECT 'admin_credit_points ratio' AS check,
       p.prosrc LIKE '%pg_catalog.floor(p_purchase_amount / 100)::bigint%' AS ok
FROM pg_catalog.pg_proc p
WHERE p.oid = 'public.admin_credit_points(uuid, numeric, text, uuid, text)'::regprocedure;

-- 5. Table grants: anon has nothing; nobody has TRUNCATE/REFERENCES/TRIGGER;
--    authenticated never has write grants on RPC-only tables.
SELECT c.relname AS table_name,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS anon_any,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE, REFERENCES, TRIGGER') AS auth_ddl_like,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE') AS auth_write,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
       (NOT pg_catalog.has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        AND NOT pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')
        AND pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
        AND (c.relname IN ('categories', 'products', 'product_images', 'stores', 'app_settings',
                           'admin_permissions', 'store_products')
             OR NOT pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE'))
        AND NOT (c.relname = 'store_products'
                 AND pg_catalog.has_table_privilege('authenticated', c.oid, 'DELETE'))
       ) AS ok
FROM pg_catalog.pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
ORDER BY 1;

-- 6. RLS still enabled on all 17 tables; policy count unchanged (pre-008: 40).
SELECT 'rls enabled on all tables' AS check,
       pg_catalog.bool_and(c.relrowsecurity) AND pg_catalog.count(*) = 17 AS ok
FROM pg_catalog.pg_class c
WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r';

SELECT 'policy count unchanged' AS check, pg_catalog.count(*) AS policies,
       pg_catalog.count(*) = 40 AS ok
FROM pg_catalog.pg_policies WHERE schemaname = 'public';

-- 7. With no JWT (SQL Editor), every helper must deny.
SELECT 'helpers deny without auth.uid()' AS check,
       NOT public.has_global_admin_role()
       AND NOT public.is_staff_or_admin()
       AND NOT public.can_access_store('abdc60b9-c664-4822-8eb0-c6063766f547') AS ok;

ROLLBACK;
