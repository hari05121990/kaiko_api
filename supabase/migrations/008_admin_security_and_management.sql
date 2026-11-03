-- =============================================================================
-- Kaiko Kart – Migration 008: Admin security fixes and admin management RPCs
-- =============================================================================
--
-- STATUS: PROPOSED – NOT APPLIED. Review before execution.
--
-- Scope
--   G2  Role helpers require an ACTIVE profile:
--         has_global_admin_role(), is_staff_or_admin(), can_access_store(uuid)
--   G1  Reward RPCs reject self-targeting and non-CUSTOMER targets:
--         admin_credit_points, admin_adjust_points, admin_reverse_points
--   A–E Customer management RPCs (global admins only):
--         admin_create_customer_profile, admin_list_customers, admin_get_customer,
--         admin_update_customer, admin_set_customer_status
--   F   Order status transitions (global admins + store-scoped staff/admin):
--         admin_update_order_status
--   G3  Table grant hardening (TRUNCATE/REFERENCES/TRIGGER, anon access).
--
-- Out of scope (see review notes): G4 delivery_status, G5 Next.js validation.
--
-- Source of truth for replaced functions: pg_get_functiondef() output captured
-- from the live database on 2026-11-02 (read-only inspection). Replaced bodies
-- are copied verbatim with the additions marked "[008/G1]".
--
-- Run as the `postgres` role (Supabase SQL Editor or psql). The whole script is
-- one transaction: any error rolls everything back.
-- If applied with the Supabase CLI (which wraps migrations in its own
-- transaction), remove the BEGIN/COMMIT lines.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

-- -----------------------------------------------------------------------------
-- 0. Preconditions – abort if the live schema differs from what was reviewed.
-- -----------------------------------------------------------------------------
DO $pre$
DECLARE
    v_sig text;
BEGIN
    FOREACH v_sig IN ARRAY ARRAY[
        'public.has_global_admin_role()',
        'public.is_staff_or_admin()',
        'public.can_access_store(uuid)',
        'public.admin_credit_points(uuid, numeric, text, uuid, text)',
        'public.admin_adjust_points(uuid, text, bigint, text, text)',
        'public.admin_reverse_points(uuid, text, text)',
        'public.cancel_order(uuid, text, boolean)',
        'public.create_reward_wallet_for_profile()'
    ] LOOP
        IF pg_catalog.to_regprocedure(v_sig) IS NULL THEN
            RAISE EXCEPTION '008 precondition failed: % not found', v_sig;
        END IF;
    END LOOP;

    FOREACH v_sig IN ARRAY ARRAY[
        'admin_create_customer_profile',
        'admin_list_customers',
        'admin_get_customer',
        'admin_update_customer',
        'admin_set_customer_status',
        'admin_update_order_status'
    ] LOOP
        IF EXISTS (
            SELECT 1 FROM pg_catalog.pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace AND p.proname = v_sig
        ) THEN
            RAISE EXCEPTION '008 precondition failed: public.% already exists', v_sig;
        END IF;
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE t.tgrelid = 'public.profiles'::regclass
          AND t.tgname = 'trg_create_reward_wallet'
          AND NOT t.tgisinternal
    ) THEN
        RAISE EXCEPTION '008 precondition failed: wallet trigger missing on public.profiles';
    END IF;

    -- New SECURITY DEFINER functions run as the migration role; it must be able
    -- to read auth.users (admin_create_customer_profile) and own the tables so
    -- RLS is not applied inside the helpers.
    IF NOT pg_catalog.has_table_privilege(current_user, 'auth.users', 'SELECT') THEN
        RAISE EXCEPTION '008 precondition failed: % cannot read auth.users', current_user;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relnamespace = 'public'::regnamespace
          AND c.relname IN ('profiles', 'user_roles', 'orders', 'reward_wallets')
          AND (c.relforcerowsecurity
               OR pg_catalog.pg_get_userbyid(c.relowner) <> current_user)
    ) THEN
        RAISE EXCEPTION '008 precondition failed: run as the owner of the public tables (expected %), RLS must not be forced', current_user;
    END IF;
END
$pre$;


-- =============================================================================
-- G2. Role helpers – require an ACTIVE profile
-- =============================================================================
-- Unchanged: signatures, LANGUAGE sql, STABLE, SECURITY DEFINER, search_path ''.
-- Changed:   the caller must also have a profiles row with status = 'ACTIVE'.
--            A user with no profile, or an INACTIVE/BLOCKED profile, gets no
--            admin/staff access anywhere these helpers are used (RLS + RPCs).
-- Recursion: these functions run as their owner (table owner, RLS not forced on
--            any table), so reading profiles/user_roles here does not evaluate
--            RLS policies. No policy on profiles/user_roles calls these helpers
--            in a way that recurses through themselves.

CREATE OR REPLACE FUNCTION public.has_global_admin_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
        WHERE ur.user_id = (SELECT auth.uid())
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN')
          AND ur.store_id IS NULL
          AND p.status = 'ACTIVE'
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_staff_or_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
        WHERE ur.user_id = (SELECT auth.uid())
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN', 'STAFF')
          AND p.status = 'ACTIVE'
    );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_store(p_store_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.profiles p ON p.id = ur.user_id
        WHERE ur.user_id = (SELECT auth.uid())
          AND p.status = 'ACTIVE'
          AND (
              (
                  ur.role IN ('SUPER_ADMIN', 'ADMIN')
                  AND (
                      ur.store_id IS NULL
                      OR ur.store_id = p_store_id
                  )
              )
              OR
              (
                  ur.role = 'STAFF'
                  AND ur.store_id = p_store_id
              )
          )
    );
$function$;


-- =============================================================================
-- G1. Reward RPCs – verbatim bodies plus [008/G1] target checks
-- =============================================================================
-- Unchanged: signatures, defaults, return types, FLOOR(amount / 100) ratio,
--            advisory-lock idempotency, wallet FOR UPDATE locking, ledger rows,
--            audit log rows, DEBIT/negative-balance checks.
-- Added:     target must not be the caller and must hold the CUSTOMER role
--            (credit/adjust already require an ACTIVE target profile).
--            reverse: the credited wallet's owner must not be the caller, must
--            have an ACTIVE profile and must hold the CUSTOMER role.

CREATE OR REPLACE FUNCTION public.admin_credit_points(p_customer_id uuid, p_purchase_amount numeric, p_idempotency_key text, p_reference_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, points_credited bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_wallet_id uuid;
    v_transaction_id uuid;
    v_points bigint;
    v_old_balance bigint;
    v_new_balance bigint;
    v_existing_type text;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_amount numeric;
    v_existing_balance bigint;
    v_description text;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to credit reward points';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_purchase_amount IS NULL OR p_purchase_amount <= 0 THEN
        RAISE EXCEPTION 'Purchase amount must be greater than zero';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    v_points := pg_catalog.floor(p_purchase_amount / 100)::bigint;

    IF v_points <= 0 THEN
        RAISE EXCEPTION 'Purchase amount must be at least Rs.100 to earn points';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = p_customer_id
          AND p.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Customer does not exist or is inactive';
    END IF;

    -- [008/G1] Target must not be the caller and must hold the CUSTOMER role.
    IF p_customer_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot credit reward points on their own account';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id
          AND ur.role = 'CUSTOMER'
    ) THEN
        RAISE EXCEPTION 'Target account is not a customer';
    END IF;

    v_description := COALESCE(
        NULLIF(pg_catalog.btrim(p_description), ''),
        'Reward points for eligible purchase'
    );

    -- Prevent concurrent requests using the same key.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    -- Return the original result if this exact request was already processed.
    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.purchase_amount,
        rt.transaction_type,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_amount,
        v_existing_type,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_type <> 'CREDIT'
           OR v_existing_amount IS DISTINCT FROM p_purchase_amount
           OR NOT EXISTS (
               SELECT 1
               FROM public.reward_wallets rw
               WHERE rw.id = v_existing_wallet
                 AND rw.customer_id = p_customer_id
           ) THEN
            RAISE EXCEPTION 'Idempotency key already used for a different transaction';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        points_credited := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    -- Create wallet if it does not exist.
    INSERT INTO public.reward_wallets (customer_id, balance)
    VALUES (p_customer_id, 0)
    ON CONFLICT (customer_id) DO NOTHING;

    -- Lock wallet before changing its balance.
    SELECT rw.id, rw.balance
    INTO v_wallet_id, v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.customer_id = p_customer_id
    FOR UPDATE;

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        reference_id,
        purchase_amount,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_wallet_id,
        'CREDIT',
        v_points,
        'PURCHASE',
        p_reference_id,
        p_purchase_amount,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = balance + v_points,
        updated_at = pg_catalog.now()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_CREDITED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', p_customer_id,
            'purchase_amount', p_purchase_amount,
            'points', v_points,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_wallet_id;
    points_credited := v_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_adjust_points(p_customer_id uuid, p_direction text, p_points bigint, p_reason text, p_idempotency_key text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, adjusted_points bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_wallet_id uuid;
    v_transaction_id uuid;
    v_old_balance bigint;
    v_new_balance bigint;
    v_description text;
    v_reference_type text;
    v_existing_type text;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_reference text;
    v_existing_description text;
    v_existing_balance bigint;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to adjust reward points';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_direction NOT IN ('CREDIT', 'DEBIT') THEN
        RAISE EXCEPTION 'Direction must be CREDIT or DEBIT';
    END IF;

    IF p_points IS NULL OR p_points <= 0 THEN
        RAISE EXCEPTION 'Points must be greater than zero';
    END IF;

    IF p_reason IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Adjustment reason is mandatory';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = p_customer_id
          AND p.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Customer does not exist or is inactive';
    END IF;

    -- [008/G1] Target must not be the caller and must hold the CUSTOMER role.
    IF p_customer_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot adjust reward points on their own account';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id
          AND ur.role = 'CUSTOMER'
    ) THEN
        RAISE EXCEPTION 'Target account is not a customer';
    END IF;

    v_reference_type := 'ADJUSTMENT_' || p_direction;
    v_description := p_direction || ': ' || pg_catalog.btrim(p_reason);

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.transaction_type,
        rt.reference_type,
        rt.description,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_type,
        v_existing_reference,
        v_existing_description,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key;

    IF FOUND THEN
        IF v_existing_type <> 'ADJUSTMENT'
           OR v_existing_points <> p_points
           OR v_existing_reference <> v_reference_type
           OR v_existing_description <> v_description
           OR NOT EXISTS (
               SELECT 1
               FROM public.reward_wallets rw
               WHERE rw.id = v_existing_wallet
                 AND rw.customer_id = p_customer_id
           ) THEN
            RAISE EXCEPTION 'Idempotency key already used for a different transaction';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        adjusted_points := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    INSERT INTO public.reward_wallets (customer_id, balance)
    VALUES (p_customer_id, 0)
    ON CONFLICT (customer_id) DO NOTHING;

    SELECT rw.id, rw.balance
    INTO v_wallet_id, v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.customer_id = p_customer_id
    FOR UPDATE;

    IF p_direction = 'DEBIT' AND v_old_balance < p_points THEN
        RAISE EXCEPTION 'Insufficient reward points for adjustment';
    END IF;

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_wallet_id,
        'ADJUSTMENT',
        p_points,
        v_reference_type,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = CASE
            WHEN p_direction = 'CREDIT' THEN balance + p_points
            ELSE balance - p_points
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_ADJUSTED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', p_customer_id,
            'direction', p_direction,
            'points', p_points,
            'reason', p_reason,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_wallet_id;
    adjusted_points := p_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reverse_points(p_original_transaction_id uuid, p_idempotency_key text, p_reason text)
 RETURNS TABLE(transaction_id uuid, wallet_id uuid, reversed_points bigint, new_balance bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid;
    v_original_wallet_id uuid;
    v_customer_id uuid;
    v_original_points bigint;
    v_original_amount numeric;
    v_original_type text;
    v_transaction_id uuid;
    v_old_balance bigint;
    v_new_balance bigint;
    v_existing_wallet uuid;
    v_existing_points bigint;
    v_existing_reference uuid;
    v_existing_balance bigint;
    v_description text;
BEGIN
    v_admin_id := auth.uid();

    IF v_admin_id IS NULL
       OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to reverse reward points';
    END IF;

    IF p_original_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Original transaction ID is required';
    END IF;

    IF p_idempotency_key IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_idempotency_key)) = 0
       OR pg_catalog.length(p_idempotency_key) > 200 THEN
        RAISE EXCEPTION 'A valid idempotency key is required';
    END IF;

    IF p_reason IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'Reversal reason is mandatory';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_idempotency_key, 0)
    );

    -- Check whether this exact reversal request already exists.
    SELECT
        rt.id,
        rt.wallet_id,
        rt.points,
        rt.reference_id,
        rw.balance
    INTO
        v_transaction_id,
        v_existing_wallet,
        v_existing_points,
        v_existing_reference,
        v_existing_balance
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.idempotency_key = p_idempotency_key
      AND rt.transaction_type = 'REVERSAL';

    IF FOUND THEN
        IF v_existing_reference IS DISTINCT FROM p_original_transaction_id THEN
            RAISE EXCEPTION 'Idempotency key already used for a different reversal';
        END IF;

        transaction_id := v_transaction_id;
        wallet_id := v_existing_wallet;
        reversed_points := v_existing_points;
        new_balance := v_existing_balance;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT
        rt.wallet_id,
        rw.customer_id,
        rt.points,
        rt.purchase_amount,
        rt.transaction_type
    INTO
        v_original_wallet_id,
        v_customer_id,
        v_original_points,
        v_original_amount,
        v_original_type
    FROM public.reward_transactions rt
    JOIN public.reward_wallets rw ON rw.id = rt.wallet_id
    WHERE rt.id = p_original_transaction_id
    FOR UPDATE OF rt;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Original reward transaction not found';
    END IF;

    IF v_original_type <> 'CREDIT'
       OR v_original_amount IS NULL THEN
        RAISE EXCEPTION 'Only purchase credit transactions can be reversed';
    END IF;

    -- [008/G1] The credited wallet must belong to an ACTIVE CUSTOMER other
    -- than the caller.
    IF v_customer_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot reverse reward points on their own account';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = v_customer_id
          AND p.status = 'ACTIVE'
    ) THEN
        RAISE EXCEPTION 'Customer does not exist or is inactive';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.user_id = v_customer_id
          AND ur.role = 'CUSTOMER'
    ) THEN
        RAISE EXCEPTION 'Target account is not a customer';
    END IF;

    -- Do not permit a second full reversal under another key.
    IF EXISTS (
        SELECT 1
        FROM public.reward_transactions rt
        WHERE rt.transaction_type = 'REVERSAL'
          AND rt.reference_type = 'REWARD_REVERSAL'
          AND rt.reference_id = p_original_transaction_id
    ) THEN
        RAISE EXCEPTION 'This purchase credit has already been reversed';
    END IF;

    SELECT rw.balance
    INTO v_old_balance
    FROM public.reward_wallets rw
    WHERE rw.id = v_original_wallet_id
    FOR UPDATE;

    IF v_old_balance < v_original_points THEN
        RAISE EXCEPTION
            'Cannot reverse: customer has already used some of these points. Current balance: %, points to reverse: %',
            v_old_balance,
            v_original_points;
    END IF;

    v_description := 'Purchase credit reversal: ' || pg_catalog.btrim(p_reason);

    INSERT INTO public.reward_transactions (
        wallet_id,
        transaction_type,
        points,
        reference_type,
        reference_id,
        purchase_amount,
        description,
        idempotency_key,
        created_by
    )
    VALUES (
        v_original_wallet_id,
        'REVERSAL',
        v_original_points,
        'REWARD_REVERSAL',
        p_original_transaction_id,
        v_original_amount,
        v_description,
        p_idempotency_key,
        v_admin_id
    )
    RETURNING id INTO v_transaction_id;

    UPDATE public.reward_wallets
    SET balance = balance - v_original_points,
        updated_at = pg_catalog.now()
    WHERE id = v_original_wallet_id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.admin_audit_logs (
        admin_id,
        action,
        entity_type,
        entity_id,
        old_data,
        new_data
    )
    VALUES (
        v_admin_id,
        'REWARD_POINTS_REVERSED',
        'reward_transactions',
        v_transaction_id,
        pg_catalog.jsonb_build_object(
            'balance', v_old_balance
        ),
        pg_catalog.jsonb_build_object(
            'customer_id', v_customer_id,
            'original_transaction_id', p_original_transaction_id,
            'points_reversed', v_original_points,
            'reason', p_reason,
            'balance', v_new_balance
        )
    );

    transaction_id := v_transaction_id;
    wallet_id := v_original_wallet_id;
    reversed_points := v_original_points;
    new_balance := v_new_balance;

    RETURN NEXT;
END;
$function$;


-- =============================================================================
-- A. admin_create_customer_profile
-- =============================================================================
-- Creates the profile + CUSTOMER role for an Auth user that the server-side
-- Next.js workflow has just created. Never creates Auth users or staff/admin
-- roles. The AFTER INSERT trigger on profiles creates the reward wallet.

CREATE FUNCTION public.admin_create_customer_profile(
    p_user_id uuid,
    p_full_name text,
    p_mobile text,
    p_email text,
    p_address text DEFAULT NULL,
    p_city text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_pincode text DEFAULT NULL
)
 RETURNS TABLE(
    customer_id uuid,
    full_name text,
    mobile text,
    email text,
    status text,
    wallet_id uuid,
    created_at timestamp with time zone
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid := auth.uid();
    v_full_name text := pg_catalog.btrim(p_full_name);
    v_mobile text := pg_catalog.btrim(p_mobile);
    v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
    v_address text := NULLIF(pg_catalog.btrim(p_address), '');
    v_city text := NULLIF(pg_catalog.btrim(p_city), '');
    v_state text := NULLIF(pg_catalog.btrim(p_state), '');
    v_pincode text := NULLIF(pg_catalog.btrim(p_pincode), '');
    v_auth_email text;
    v_wallet_id uuid;
    v_created_at timestamptz;
BEGIN
    IF v_admin_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to create customer accounts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User ID is required';
    END IF;

    IF p_user_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot create a customer profile for their own account'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Input validation (lengths mirror the profiles column limits).
    IF v_full_name IS NULL OR v_full_name = '' OR pg_catalog.length(v_full_name) > 150 THEN
        RAISE EXCEPTION 'Full name is required and must not exceed 150 characters';
    END IF;

    IF v_mobile IS NULL OR v_mobile !~ '^\+?[0-9]{10,15}$' THEN
        RAISE EXCEPTION 'Mobile must be 10-15 digits, optionally prefixed with +';
    END IF;

    IF v_email IS NULL
       OR pg_catalog.length(v_email) > 150
       OR v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'A valid email address is required';
    END IF;

    IF v_address IS NOT NULL AND pg_catalog.length(v_address) > 500 THEN
        RAISE EXCEPTION 'Address must not exceed 500 characters';
    END IF;

    IF (v_city IS NOT NULL AND pg_catalog.length(v_city) > 100)
       OR (v_state IS NOT NULL AND pg_catalog.length(v_state) > 100) THEN
        RAISE EXCEPTION 'City and state must not exceed 100 characters';
    END IF;

    IF v_pincode IS NOT NULL AND v_pincode !~ '^[1-9][0-9]{5}$' THEN
        RAISE EXCEPTION 'Pincode must be a 6-digit Indian pincode';
    END IF;

    -- Serialise concurrent creation for the same user or mobile number.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('kk_customer_user:' || p_user_id::text, 0)
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('kk_customer_mobile:' || v_mobile, 0)
    );

    SELECT u.email
    INTO v_auth_email
    FROM auth.users u
    WHERE u.id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Auth user not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_auth_email IS NULL
       OR pg_catalog.lower(v_auth_email) <> v_email THEN
        RAISE EXCEPTION 'Email does not match the Auth user';
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN
        RAISE EXCEPTION 'User already has a profile'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = p_user_id) THEN
        RAISE EXCEPTION 'User already has a role assignment'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.mobile = v_mobile) THEN
        RAISE EXCEPTION 'Mobile number is already registered'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (SELECT 1 FROM public.profiles p WHERE pg_catalog.lower(p.email) = v_email) THEN
        RAISE EXCEPTION 'Email is already registered'
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.profiles AS p (
        id, full_name, mobile, email, address, city, state, pincode, status
    )
    VALUES (
        p_user_id, v_full_name, v_mobile, v_email, v_address, v_city, v_state, v_pincode, 'ACTIVE'
    )
    RETURNING p.created_at INTO v_created_at;

    INSERT INTO public.user_roles (user_id, role, store_id)
    VALUES (p_user_id, 'CUSTOMER', NULL);

    -- Created by trg_create_reward_wallet in this same transaction.
    SELECT rw.id
    INTO v_wallet_id
    FROM public.reward_wallets rw
    WHERE rw.customer_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reward wallet was not created for the new profile';
    END IF;

    INSERT INTO public.admin_audit_logs (
        admin_id, action, entity_type, entity_id, old_data, new_data
    )
    VALUES (
        v_admin_id,
        'CUSTOMER_CREATED',
        'profiles',
        p_user_id,
        NULL,
        pg_catalog.jsonb_build_object(
            'full_name', v_full_name,
            'mobile', v_mobile,
            'email', v_email,
            'city', v_city,
            'state', v_state,
            'pincode', v_pincode,
            'status', 'ACTIVE',
            'role', 'CUSTOMER',
            'wallet_id', v_wallet_id
        )
    );

    RETURN QUERY
    SELECT p_user_id, v_full_name, v_mobile, v_email, 'ACTIVE'::text, v_wallet_id, v_created_at;
END;
$function$;


-- =============================================================================
-- B. admin_list_customers
-- =============================================================================
-- CUSTOMER-role accounts only (EXISTS, so multiple role rows never duplicate).
-- total_count is the full match count (window function); it is absent when
-- p_offset is beyond the last match because no rows are returned.

CREATE FUNCTION public.admin_list_customers(
    p_search text DEFAULT NULL,
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 20,
    p_offset integer DEFAULT 0
)
 RETURNS TABLE(
    customer_id uuid,
    full_name text,
    mobile text,
    email text,
    city text,
    state text,
    status text,
    wallet_balance bigint,
    created_at timestamp with time zone,
    total_count bigint
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_search text := NULLIF(pg_catalog.btrim(p_search), '');
    v_status text := NULLIF(pg_catalog.upper(pg_catalog.btrim(p_status)), '');
    v_limit integer := COALESCE(p_limit, 20);
    v_offset integer := COALESCE(p_offset, 0);
    v_pattern text;
BEGIN
    IF auth.uid() IS NULL OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to view customers'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_status IS NOT NULL AND v_status NOT IN ('ACTIVE', 'INACTIVE', 'BLOCKED') THEN
        RAISE EXCEPTION 'Status must be ACTIVE, INACTIVE or BLOCKED';
    END IF;

    IF v_limit < 1 OR v_limit > 100 THEN
        RAISE EXCEPTION 'Limit must be between 1 and 100';
    END IF;

    IF v_offset < 0 THEN
        RAISE EXCEPTION 'Offset must not be negative';
    END IF;

    IF v_search IS NOT NULL THEN
        IF pg_catalog.length(v_search) > 100 THEN
            RAISE EXCEPTION 'Search text must not exceed 100 characters';
        END IF;

        -- Escape LIKE wildcards so the search is a literal substring match.
        v_pattern := '%'
            || pg_catalog.replace(
                   pg_catalog.replace(
                       pg_catalog.replace(v_search, '\', '\\'),
                   '%', '\%'),
               '_', '\_')
            || '%';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name::text,
        p.mobile::text,
        p.email::text,
        p.city::text,
        p.state::text,
        p.status::text,
        rw.balance,
        p.created_at,
        pg_catalog.count(*) OVER ()
    FROM public.profiles p
    LEFT JOIN public.reward_wallets rw ON rw.customer_id = p.id
    WHERE EXISTS (
              SELECT 1
              FROM public.user_roles ur
              WHERE ur.user_id = p.id
                AND ur.role = 'CUSTOMER'
          )
      AND (v_status IS NULL OR p.status = v_status)
      AND (
              v_pattern IS NULL
              OR p.full_name ILIKE v_pattern
              OR p.mobile ILIKE v_pattern
              OR p.email ILIKE v_pattern
          )
    ORDER BY p.created_at DESC, p.id
    LIMIT v_limit
    OFFSET v_offset;
END;
$function$;


-- =============================================================================
-- C. admin_get_customer
-- =============================================================================

CREATE FUNCTION public.admin_get_customer(p_customer_id uuid)
 RETURNS TABLE(
    customer_id uuid,
    full_name text,
    mobile text,
    email text,
    address text,
    city text,
    state text,
    pincode text,
    status text,
    wallet_id uuid,
    wallet_balance bigint,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NULL OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to view customers'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name::text,
        p.mobile::text,
        p.email::text,
        p.address,
        p.city::text,
        p.state::text,
        p.pincode::text,
        p.status::text,
        rw.id,
        rw.balance,
        p.created_at,
        p.updated_at
    FROM public.profiles p
    LEFT JOIN public.reward_wallets rw ON rw.customer_id = p.id
    WHERE p.id = p_customer_id
      AND EXISTS (
              SELECT 1
              FROM public.user_roles ur
              WHERE ur.user_id = p.id
                AND ur.role = 'CUSTOMER'
          );

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Customer not found'
            USING ERRCODE = 'no_data_found';
    END IF;
END;
$function$;


-- =============================================================================
-- D. admin_update_customer
-- =============================================================================
-- NULL parameter  = keep the current value.
-- Empty string    = clear an optional field (address, city, state, pincode).
-- full_name and mobile cannot be cleared. Email, id, role, status and wallet
-- are not editable here. Accounts that also hold SUPER_ADMIN/ADMIN/STAFF roles
-- are excluded so customer management cannot alter privileged accounts.

CREATE FUNCTION public.admin_update_customer(
    p_customer_id uuid,
    p_full_name text DEFAULT NULL,
    p_mobile text DEFAULT NULL,
    p_address text DEFAULT NULL,
    p_city text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_pincode text DEFAULT NULL
)
 RETURNS TABLE(
    customer_id uuid,
    full_name text,
    mobile text,
    email text,
    address text,
    city text,
    state text,
    pincode text,
    status text,
    updated_at timestamp with time zone,
    changed boolean
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid := auth.uid();
    v_old public.profiles%ROWTYPE;
    v_full_name text;
    v_mobile text;
    v_address text;
    v_city text;
    v_state text;
    v_pincode text;
    v_changed boolean;
BEGIN
    IF v_admin_id IS NULL OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to update customers'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_customer_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot modify their own account through customer management'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT p.*
    INTO v_old
    FROM public.profiles p
    WHERE p.id = p_customer_id
    FOR UPDATE;

    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id AND ur.role = 'CUSTOMER'
    ) THEN
        RAISE EXCEPTION 'Customer not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN', 'STAFF')
    ) THEN
        RAISE EXCEPTION 'Staff and administrator accounts cannot be modified through customer management'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_full_name := COALESCE(pg_catalog.btrim(p_full_name), v_old.full_name);
    v_mobile := COALESCE(pg_catalog.btrim(p_mobile), v_old.mobile);
    v_address := CASE WHEN p_address IS NULL THEN v_old.address
                      ELSE NULLIF(pg_catalog.btrim(p_address), '') END;
    v_city := CASE WHEN p_city IS NULL THEN v_old.city
                   ELSE NULLIF(pg_catalog.btrim(p_city), '') END;
    v_state := CASE WHEN p_state IS NULL THEN v_old.state
                    ELSE NULLIF(pg_catalog.btrim(p_state), '') END;
    v_pincode := CASE WHEN p_pincode IS NULL THEN v_old.pincode
                      ELSE NULLIF(pg_catalog.btrim(p_pincode), '') END;

    IF v_full_name IS NULL OR v_full_name = '' OR pg_catalog.length(v_full_name) > 150 THEN
        RAISE EXCEPTION 'Full name is required and must not exceed 150 characters';
    END IF;

    IF v_mobile IS NULL OR v_mobile !~ '^\+?[0-9]{10,15}$' THEN
        RAISE EXCEPTION 'Mobile must be 10-15 digits, optionally prefixed with +';
    END IF;

    IF v_address IS NOT NULL AND pg_catalog.length(v_address) > 500 THEN
        RAISE EXCEPTION 'Address must not exceed 500 characters';
    END IF;

    IF (v_city IS NOT NULL AND pg_catalog.length(v_city) > 100)
       OR (v_state IS NOT NULL AND pg_catalog.length(v_state) > 100) THEN
        RAISE EXCEPTION 'City and state must not exceed 100 characters';
    END IF;

    IF v_pincode IS NOT NULL AND v_pincode !~ '^[1-9][0-9]{5}$' THEN
        RAISE EXCEPTION 'Pincode must be a 6-digit Indian pincode';
    END IF;

    IF v_mobile IS DISTINCT FROM v_old.mobile THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended('kk_customer_mobile:' || v_mobile, 0)
        );

        IF EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.mobile = v_mobile AND p.id <> p_customer_id
        ) THEN
            RAISE EXCEPTION 'Mobile number is already registered'
                USING ERRCODE = 'unique_violation';
        END IF;
    END IF;

    v_changed := v_full_name IS DISTINCT FROM v_old.full_name::text
              OR v_mobile IS DISTINCT FROM v_old.mobile::text
              OR v_address IS DISTINCT FROM v_old.address
              OR v_city IS DISTINCT FROM v_old.city::text
              OR v_state IS DISTINCT FROM v_old.state::text
              OR v_pincode IS DISTINCT FROM v_old.pincode::text;

    IF v_changed THEN
        UPDATE public.profiles AS p
        SET full_name = v_full_name,
            mobile = v_mobile,
            address = v_address,
            city = v_city,
            state = v_state,
            pincode = v_pincode,
            updated_at = pg_catalog.now()
        WHERE p.id = p_customer_id;

        INSERT INTO public.admin_audit_logs (
            admin_id, action, entity_type, entity_id, old_data, new_data
        )
        VALUES (
            v_admin_id,
            'CUSTOMER_UPDATED',
            'profiles',
            p_customer_id,
            pg_catalog.jsonb_build_object(
                'full_name', v_old.full_name,
                'mobile', v_old.mobile,
                'address', v_old.address,
                'city', v_old.city,
                'state', v_old.state,
                'pincode', v_old.pincode
            ),
            pg_catalog.jsonb_build_object(
                'full_name', v_full_name,
                'mobile', v_mobile,
                'address', v_address,
                'city', v_city,
                'state', v_state,
                'pincode', v_pincode
            )
        );
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name::text,
        p.mobile::text,
        p.email::text,
        p.address,
        p.city::text,
        p.state::text,
        p.pincode::text,
        p.status::text,
        p.updated_at,
        v_changed
    FROM public.profiles p
    WHERE p.id = p_customer_id;
END;
$function$;


-- =============================================================================
-- E. admin_set_customer_status
-- =============================================================================
-- Changes profiles.status only. Never touches user_roles, wallets or history.

CREATE FUNCTION public.admin_set_customer_status(
    p_customer_id uuid,
    p_status text,
    p_reason text
)
 RETURNS TABLE(
    customer_id uuid,
    old_status text,
    new_status text,
    changed boolean
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_admin_id uuid := auth.uid();
    v_status text := pg_catalog.upper(pg_catalog.btrim(p_status));
    v_reason text := pg_catalog.btrim(p_reason);
    v_old_status text;
BEGIN
    IF v_admin_id IS NULL OR NOT public.has_global_admin_role() THEN
        RAISE EXCEPTION 'Not authorised to change customer status'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_customer_id IS NULL THEN
        RAISE EXCEPTION 'Customer ID is required';
    END IF;

    IF p_customer_id = v_admin_id THEN
        RAISE EXCEPTION 'Administrators cannot change the status of their own account'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_status IS NULL OR v_status NOT IN ('ACTIVE', 'INACTIVE', 'BLOCKED') THEN
        RAISE EXCEPTION 'Status must be ACTIVE, INACTIVE or BLOCKED';
    END IF;

    IF v_reason IS NULL OR v_reason = '' OR pg_catalog.length(v_reason) > 500 THEN
        RAISE EXCEPTION 'A reason is required and must not exceed 500 characters';
    END IF;

    SELECT p.status
    INTO v_old_status
    FROM public.profiles p
    WHERE p.id = p_customer_id
    FOR UPDATE;

    IF NOT FOUND OR NOT EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id AND ur.role = 'CUSTOMER'
    ) THEN
        RAISE EXCEPTION 'Customer not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_customer_id
          AND ur.role IN ('SUPER_ADMIN', 'ADMIN', 'STAFF')
    ) THEN
        RAISE EXCEPTION 'Staff and administrator accounts cannot be modified through customer management'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_old_status = v_status THEN
        RETURN QUERY SELECT p_customer_id, v_old_status, v_status, false;
        RETURN;
    END IF;

    UPDATE public.profiles AS p
    SET status = v_status,
        updated_at = pg_catalog.now()
    WHERE p.id = p_customer_id;

    INSERT INTO public.admin_audit_logs (
        admin_id, action, entity_type, entity_id, old_data, new_data
    )
    VALUES (
        v_admin_id,
        'CUSTOMER_STATUS_CHANGED',
        'profiles',
        p_customer_id,
        pg_catalog.jsonb_build_object('status', v_old_status),
        pg_catalog.jsonb_build_object('status', v_status, 'reason', v_reason)
    );

    RETURN QUERY SELECT p_customer_id, v_old_status, v_status, true;
END;
$function$;


-- =============================================================================
-- F. admin_update_order_status
-- =============================================================================
-- Approved transitions (no skipping, no going back):
--   PICKUP:        PENDING -> CONFIRMED -> READY_FOR_PICKUP -> COMPLETED
--   HOME_DELIVERY: PENDING -> CONFIRMED -> OUT_FOR_DELIVERY -> COMPLETED
-- CANCELLED only via cancel_order(). REFUNDED is not supported.
-- delivery_status is intentionally not changed here (see G4).
-- Orders outside the caller's store scope are reported as "Order not found".

CREATE FUNCTION public.admin_update_order_status(
    p_order_id uuid,
    p_new_status text,
    p_remarks text DEFAULT NULL
)
 RETURNS TABLE(
    order_id uuid,
    order_number text,
    old_status text,
    new_status text,
    updated_at timestamp with time zone
 )
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_order public.orders%ROWTYPE;
    v_new text := pg_catalog.upper(pg_catalog.btrim(p_new_status));
    v_remarks text := NULLIF(pg_catalog.btrim(p_remarks), '');
    v_allowed boolean;
    v_now timestamptz := pg_catalog.now();
BEGIN
    IF v_actor_id IS NULL OR NOT public.is_staff_or_admin() THEN
        RAISE EXCEPTION 'Not authorised to update order status'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_order_id IS NULL THEN
        RAISE EXCEPTION 'Order ID is required';
    END IF;

    IF v_new IS NULL OR v_new = '' THEN
        RAISE EXCEPTION 'New status is required';
    END IF;

    IF v_new = 'CANCELLED' THEN
        RAISE EXCEPTION 'Orders can only be cancelled through order cancellation';
    END IF;

    IF v_new = 'REFUNDED' THEN
        RAISE EXCEPTION 'Refunds are not supported';
    END IF;

    IF v_new NOT IN ('CONFIRMED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED') THEN
        RAISE EXCEPTION 'Invalid target order status. Allowed: CONFIRMED, READY_FOR_PICKUP, OUT_FOR_DELIVERY, COMPLETED';
    END IF;

    IF v_remarks IS NOT NULL AND pg_catalog.length(v_remarks) > 500 THEN
        RAISE EXCEPTION 'Remarks must not exceed 500 characters';
    END IF;

    SELECT o.*
    INTO v_order
    FROM public.orders o
    WHERE o.id = p_order_id
    FOR UPDATE;

    IF NOT FOUND OR NOT public.can_access_store(v_order.store_id) THEN
        RAISE EXCEPTION 'Order not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_order.order_status = v_new THEN
        RAISE EXCEPTION 'Order is already %', v_new;
    END IF;

    IF v_order.order_status IN ('COMPLETED', 'CANCELLED', 'REFUNDED') THEN
        RAISE EXCEPTION 'Order is % and its status can no longer be changed',
            v_order.order_status;
    END IF;

    v_allowed := CASE v_order.fulfilment_type
        WHEN 'PICKUP' THEN
            (v_order.order_status::text, v_new) IN (
                ('PENDING', 'CONFIRMED'),
                ('CONFIRMED', 'READY_FOR_PICKUP'),
                ('READY_FOR_PICKUP', 'COMPLETED')
            )
        WHEN 'HOME_DELIVERY' THEN
            (v_order.order_status::text, v_new) IN (
                ('PENDING', 'CONFIRMED'),
                ('CONFIRMED', 'OUT_FOR_DELIVERY'),
                ('OUT_FOR_DELIVERY', 'COMPLETED')
            )
        ELSE false
    END;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'Status change from % to % is not allowed for % orders',
            v_order.order_status, v_new, v_order.fulfilment_type;
    END IF;

    UPDATE public.orders AS o
    SET order_status = v_new,
        updated_at = v_now
    WHERE o.id = v_order.id;

    INSERT INTO public.order_status_history (
        order_id, old_status, new_status, remarks, changed_by
    )
    VALUES (
        v_order.id,
        v_order.order_status,
        v_new,
        COALESCE(v_remarks, 'Status updated by authorised staff/admin'),
        v_actor_id
    );

    INSERT INTO public.admin_audit_logs (
        admin_id, action, entity_type, entity_id, old_data, new_data
    )
    VALUES (
        v_actor_id,
        'ORDER_STATUS_UPDATED',
        'ORDER',
        v_order.id,
        pg_catalog.jsonb_build_object(
            'order_status', v_order.order_status,
            'delivery_status', v_order.delivery_status
        ),
        pg_catalog.jsonb_build_object(
            'order_status', v_new,
            'remarks', v_remarks
        )
    );

    RETURN QUERY
    SELECT v_order.id, v_order.order_number::text, v_order.order_status::text, v_new, v_now;
END;
$function$;


-- =============================================================================
-- Function privileges
-- =============================================================================
-- New functions: Postgres grants EXECUTE to PUBLIC on CREATE FUNCTION and
-- Supabase default privileges add anon/authenticated. Restrict to the same
-- pattern as the existing RPCs: authenticated + service_role only.
-- Replaced functions keep their ACLs under CREATE OR REPLACE; the REVOKEs below
-- are defensive no-ops that pin the intended state.

REVOKE ALL ON FUNCTION public.admin_create_customer_profile(uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_customers(text, text, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_customer(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_customer(uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_customer_status(uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_order_status(uuid, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.admin_create_customer_profile(uuid, text, text, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_customers(text, text, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_customer(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_customer(uuid, text, text, text, text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_customer_status(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_order_status(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.has_global_admin_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_staff_or_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_access_store(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_credit_points(uuid, numeric, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_adjust_points(uuid, text, bigint, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reverse_points(uuid, text, text) FROM PUBLIC, anon;


-- =============================================================================
-- G3. Table grant hardening
-- =============================================================================
-- Every RLS policy in public targets the `authenticated` role; none targets
-- anon. anon therefore has no effective row access today, and its grants only
-- add risk (TRUNCATE bypasses RLS entirely).
--
-- Kept on purpose for `authenticated`:
--   SELECT on all tables (RLS decides rows).
--   INSERT/UPDATE/DELETE on categories, products, product_images, stores,
--   app_settings, admin_permissions – each has a matching admin-only policy and
--   is needed by future management APIs.
--   INSERT/UPDATE on store_products – matching can_access_store policies.
-- Never granted: writes on orders, order_items, order_status_history,
--   reward_wallets, reward_transactions, admin_audit_logs, profiles,
--   user_roles, inventory_transactions, customer_addresses (RPC-only).

-- anon: remove all table privileges (no anon policies exist).
REVOKE ALL ON TABLE
    public.stores, public.profiles, public.user_roles, public.admin_permissions,
    public.categories, public.products, public.store_products, public.product_images,
    public.inventory_transactions, public.customer_addresses, public.reward_wallets,
    public.reward_transactions, public.orders, public.order_items,
    public.order_status_history, public.admin_audit_logs, public.app_settings
FROM anon;

-- authenticated: TRUNCATE bypasses RLS; REFERENCES/TRIGGER are DDL-level and unused.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE
    public.stores, public.profiles, public.user_roles, public.admin_permissions,
    public.categories, public.products, public.store_products, public.product_images,
    public.inventory_transactions, public.customer_addresses, public.reward_wallets,
    public.reward_transactions, public.orders, public.order_items,
    public.order_status_history, public.admin_audit_logs, public.app_settings
FROM authenticated;

-- authenticated: store_products has no DELETE policy, so DELETE is already
-- denied by RLS; remove the grant so intent is explicit (use is_available).
REVOKE DELETE ON TABLE public.store_products FROM authenticated;

-- Make the new RPCs visible to the Data API immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
